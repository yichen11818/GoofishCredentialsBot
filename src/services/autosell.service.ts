/**
 * 自动发货服务
 */

import { createLogger } from '../core/logger.js'
import {
    getEnabledAutoSellRules,
    getAutoSellRule,
    getStockStats,
    consumeStock,
    addDeliveryLog,
    hasDelivered
} from '../db/index.js'
import type { AutoSellRule, DeliveryResult, ApiConfig } from '../types/index.js'

const logger = createLogger('Svc:AutoSell')

function parsePriceValue(price?: string | number | null): number | null {
    if (price === null || price === undefined || price === '') {
        return null
    }

    if (typeof price === 'number') {
        return Number.isFinite(price) ? price : null
    }

    const normalized = String(price).replace(/,/g, '').trim()
    const match = normalized.match(/-?\d+(?:\.\d+)?/)
    if (!match) {
        return null
    }

    const value = Number.parseFloat(match[0])
    return Number.isFinite(value) ? value : null
}

function isPriceMatched(rule: AutoSellRule, orderPrice?: string | number | null): boolean {
    if (rule.minPrice === null && rule.maxPrice === null) {
        return true
    }

    const priceValue = parsePriceValue(orderPrice)
    if (priceValue === null) {
        return false
    }

    if (rule.minPrice !== null && priceValue < rule.minPrice) {
        return false
    }

    if (rule.maxPrice !== null && priceValue > rule.maxPrice) {
        return false
    }

    return true
}

function getPriceRangeSpan(rule: AutoSellRule): number {
    if (rule.minPrice !== null && rule.maxPrice !== null) {
        return Math.max(rule.maxPrice - rule.minPrice, 0)
    }

    return Number.POSITIVE_INFINITY
}

function compareMatchedRules(a: AutoSellRule, b: AutoSellRule): number {
    const aSpecificity =
        (a.itemId ? 4 : 0) +
        (a.accountId ? 2 : 0) +
        (a.minPrice !== null || a.maxPrice !== null ? 1 : 0)
    const bSpecificity =
        (b.itemId ? 4 : 0) +
        (b.accountId ? 2 : 0) +
        (b.minPrice !== null || b.maxPrice !== null ? 1 : 0)

    if (aSpecificity !== bSpecificity) {
        return bSpecificity - aSpecificity
    }

    const spanDiff = getPriceRangeSpan(a) - getPriceRangeSpan(b)
    if (spanDiff !== 0) {
        return spanDiff
    }

    return a.id - b.id
}

export function findMatchedAutoSellRule(
    accountId: string,
    itemId?: string,
    triggerOn: 'paid' | 'confirmed' = 'paid',
    orderPrice?: string | number | null
): AutoSellRule | null {
    const rules = getEnabledAutoSellRules(accountId, itemId)
        .filter(rule => rule.triggerOn === triggerOn)
        .filter(rule => isPriceMatched(rule, orderPrice))
        .sort(compareMatchedRules)

    return rules[0] || null
}

/**
 * 通过 API 获取发货内容
 */
async function fetchFromApi(config: ApiConfig, context: Record<string, string>): Promise<string> {
    let url = config.url
    let body = config.body

    // 替换变量
    for (const [key, value] of Object.entries(context)) {
        const placeholder = `{{${key}}}`
        url = url.replace(new RegExp(placeholder, 'g'), value)
        if (body) {
            body = body.replace(new RegExp(placeholder, 'g'), value)
        }
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config.headers
    }

    const response = await fetch(url, {
        method: config.method,
        headers,
        body: config.method === 'POST' ? body : undefined
    })

    if (!response.ok) {
        throw new Error(`API 请求失败: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()

    // 从响应中提取内容
    if (config.responseField) {
        const fields = config.responseField.split('.')
        let result = data
        for (const field of fields) {
            result = result?.[field]
        }
        if (result === undefined) {
            throw new Error(`响应中未找到字段: ${config.responseField}`)
        }
        return String(result)
    }

    return typeof data === 'string' ? data : JSON.stringify(data)
}


/**
 * 执行发货
 */
async function executeDelivery(
    rule: AutoSellRule,
    orderId: string,
    context: Record<string, string>
): Promise<DeliveryResult> {
    switch (rule.deliveryType) {
        case 'fixed':
            if (!rule.deliveryContent) {
                return { success: false, error: '未配置发货内容' }
            }
            return { success: true, content: rule.deliveryContent }

        case 'stock': {
            const stock = consumeStock(rule.id, orderId)
            if (!stock) {
                return { success: false, error: '库存不足' }
            }
            return {
                success: true,
                content: stock.content,
                followUpMessage: rule.followUpMessage || undefined
            }
        }

        case 'api': {
            if (!rule.apiConfig) {
                return { success: false, error: '未配置 API' }
            }
            try {
                const content = await fetchFromApi(rule.apiConfig, context)
                return { success: true, content }
            } catch (e: any) {
                return { success: false, error: e.message }
            }
        }

        default:
            return { success: false, error: '未知发货类型' }
    }
}

/**
 * 处理订单自动发货
 */
export async function processAutoSell(
    accountId: string,
    orderId: string,
    itemId?: string,
    options: {
        triggerOn?: 'paid' | 'confirmed'
        ruleId?: number
        orderPrice?: string | number | null
    } = {}
): Promise<DeliveryResult & { ruleName?: string }> {
    // 检查是否已发货
    if (hasDelivered(orderId)) {
        logger.info(`订单 ${orderId} 已发货，跳过`)
        return { success: false, error: '订单已发货' }
    }

    // 获取匹配的规则
    const matchedRule = options.ruleId
        ? getAutoSellRule(options.ruleId)
        : findMatchedAutoSellRule(
            accountId,
            itemId,
            options.triggerOn || 'paid',
            options.orderPrice
        )

    if (!matchedRule) {
        logger.debug(`订单 ${orderId} 无匹配的自动发货规则`)
        return { success: false, error: '无匹配规则' }
    }

    // 检查库存类型的库存是否充足
    if (matchedRule.deliveryType === 'stock') {
        const stats = getStockStats(matchedRule.id)
        if (stats.available <= 0) {
            logger.warn(`规则 "${matchedRule.name}" 库存不足`)
            return { success: false, error: '库存不足', ruleName: matchedRule.name }
        }
    }

    // 执行发货
    const context = {
        orderId,
        accountId,
        itemId: itemId || '',
        orderPrice: options.orderPrice != null ? String(options.orderPrice) : ''
    }
    const result = await executeDelivery(matchedRule, orderId, context)

    // 记录发货日志
    addDeliveryLog({
        ruleId: matchedRule.id,
        orderId,
        accountId,
        deliveryType: matchedRule.deliveryType,
        content: result.content || '',
        status: result.success ? 'success' : 'failed',
        errorMessage: result.error
    })

    if (result.success) {
        logger.info(`订单 ${orderId} 自动发货成功: ${matchedRule.name}`)
    } else {
        logger.error(`订单 ${orderId} 自动发货失败: ${result.error}`)
    }

    return { ...result, ruleName: matchedRule.name }
}

/**
 * 获取规则的库存状态
 */
export function getRuleStockStatus(ruleId: number) {
    return getStockStats(ruleId)
}
