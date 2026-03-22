/**
 * 自动发货 API 路由
 */

import { Hono } from 'hono'

import {
    getOrders,
    getAutoSellRules,
    getAutoSellRule,
    createAutoSellRule,
    updateAutoSellRule,
    deleteAutoSellRule,
    toggleAutoSellRule,
    getStockItems,
    getStockStats,
    addStockItems,
    clearStock,
    getDeliveryLogs
} from '../../db/index.js'
import { OrderStatus } from '../../types/order.types.js'
import type {
    AutoSellRule,
    UncoveredAutoSellItemAlert,
    UncoveredAutoSellSuggestedRule
} from '../../types/index.js'

export function createAutoSellRoutes() {
    const router = new Hono()

    function normalizeItemIds(itemIds: Array<string | null | undefined>): string[] {
        return Array.from(
            new Set(
                itemIds
                    .map(itemId => String(itemId || '').trim())
                    .filter(Boolean)
            )
        )
    }

    function getRuleItemIds(rule: ReturnType<typeof getAutoSellRules>[number]): string[] {
        return normalizeItemIds(rule.itemIds?.length ? rule.itemIds : [rule.itemId])
    }

    function isRuleItemMatched(rule: ReturnType<typeof getAutoSellRules>[number], itemId?: string | null): boolean {
        const ruleItemIds = getRuleItemIds(rule)
        if (ruleItemIds.length === 0) {
            return true
        }

        if (!itemId) {
            return false
        }

        return ruleItemIds.includes(itemId)
    }

    function getRequestedItemIds(rawItemIds?: string | null, rawItemId?: string | null): string[] {
        const parsedItemIds = rawItemIds
            ? rawItemIds
                .split(',')
                .map(itemId => itemId.trim())
                .filter(Boolean)
            : []

        return normalizeItemIds([...parsedItemIds, rawItemId])
    }

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

    function isRuleAccountMatched(rule: AutoSellRule, accountId?: string | null): boolean {
        if (!accountId) {
            return true
        }

        return rule.accountId === null || rule.accountId === accountId
    }

    function isPriceMatched(
        rule: Pick<AutoSellRule, 'minPrice' | 'maxPrice'>,
        orderPrice?: string | number | null
    ): boolean {
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

    function formatPriceValue(price: number): string {
        return price.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
    }

    function getExportGroupTitle(rule: ReturnType<typeof getAutoSellRules>[number]): string {
        if (rule.stockGroupLabel?.trim()) {
            return rule.stockGroupLabel.trim()
        }

        if (rule.minPrice !== null && rule.maxPrice !== null) {
            return formatPriceValue((rule.minPrice + rule.maxPrice) / 2)
        }

        if (rule.minPrice !== null) {
            return `>= ${formatPriceValue(rule.minPrice)}`
        }

        if (rule.maxPrice !== null) {
            return `<= ${formatPriceValue(rule.maxPrice)}`
        }

        return rule.name
    }

    // ========== 规则管理 ==========

    // 获取所有规则
    router.get('/', (c) => {
        const rules = getAutoSellRules()
        // 附加库存统计
        const rulesWithStats = rules.map(r => {
            if (r.deliveryType === 'stock') {
                const stats = getStockStats(r.id)
                return { ...r, stockCount: stats.total, usedCount: stats.used }
            }
            return r
        })
        return c.json({ rules: rulesWithStats })
    })

    // 导出未使用库存（按分组文本）
    router.get('/export-unused', (c) => {
        const itemIds = getRequestedItemIds(c.req.query('itemIds'), c.req.query('itemId'))
        const accountId = c.req.query('accountId') || undefined
        const triggerOn = c.req.query('triggerOn') || undefined

        if (itemIds.length === 0) {
            return c.json({ error: '请提供至少一个商品 ID' }, 400)
        }

        const matchedRules = getAutoSellRules()
            .filter(rule => rule.deliveryType === 'stock')
            .filter(rule => {
                const ruleItemIds = getRuleItemIds(rule)
                return ruleItemIds.length === 0 || ruleItemIds.some(itemId => itemIds.includes(itemId))
            })
            .filter(rule => !accountId || rule.accountId === null || rule.accountId === accountId)
            .filter(rule => !triggerOn || rule.triggerOn === triggerOn)
            .sort((a, b) => {
                const aPrice = a.minPrice ?? a.maxPrice ?? Number.POSITIVE_INFINITY
                const bPrice = b.minPrice ?? b.maxPrice ?? Number.POSITIVE_INFINITY
                if (aPrice !== bPrice) return aPrice - bPrice
                return a.id - b.id
            })

        const groups = matchedRules
            .map(rule => ({
                title: getExportGroupTitle(rule),
                items: getStockItems(rule.id, false)
            }))
            .filter(group => group.items.length > 0)

        const content = groups
            .map(group => [
                `[${group.title}]`,
                ...group.items.map(item => item.content)
            ].join('\n'))
            .join('\n\n')

        const stockCount = groups.reduce((sum, group) => sum + group.items.length, 0)

        return c.json({
            content,
            ruleCount: groups.length,
            stockCount
        })
    })

    // 最近订单里未覆盖的新商品 ID 提示
    router.get('/coverage-alerts', (c) => {
        const accountId = c.req.query('accountId') || undefined
        const triggerOn = c.req.query('triggerOn') === 'confirmed' ? 'confirmed' : 'paid'
        const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10), 1), 100)

        const enabledRules = getAutoSellRules()
            .filter(rule => rule.enabled)
            .filter(rule => rule.triggerOn === triggerOn)
            .filter(rule => isRuleAccountMatched(rule, accountId))

        const recentOrders = getOrders({
            accountId,
            limit: Math.max(limit * 5, 50),
            offset: 0
        })
            .filter(order => order.itemId)
            .filter(order =>
                order.status === OrderStatus.PENDING_SHIPMENT ||
                order.status === OrderStatus.PENDING_RECEIPT ||
                order.status === OrderStatus.COMPLETED
            )

        const alertsByItemId = new Map<string, UncoveredAutoSellItemAlert>()

        for (const order of recentOrders) {
            const itemId = order.itemId
            if (!itemId) continue

            const itemCovered = enabledRules.some(rule => {
                return isRuleAccountMatched(rule, order.accountId) &&
                    isRuleItemMatched(rule, itemId) &&
                    isPriceMatched(rule, order.price)
            })

            if (itemCovered) {
                continue
            }

            const suggestedRules: UncoveredAutoSellSuggestedRule[] = enabledRules
                .filter(rule => isRuleAccountMatched(rule, order.accountId))
                .filter(rule => isPriceMatched(rule, order.price))
                .map(rule => ({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    minPrice: rule.minPrice,
                    maxPrice: rule.maxPrice
                }))

            const existing = alertsByItemId.get(itemId)
            if (!existing) {
                alertsByItemId.set(itemId, {
                    accountId: order.accountId,
                    itemId,
                    itemTitle: order.itemTitle,
                    latestOrderId: order.orderId,
                    latestPrice: order.price,
                    latestStatus: order.status,
                    latestStatusText: order.statusText,
                    latestUpdatedAt: order.updatedAt,
                    recentOrderCount: 1,
                    suggestedRules
                })
                continue
            }

            existing.recentOrderCount += 1
            if (order.updatedAt > existing.latestUpdatedAt) {
                existing.itemTitle = order.itemTitle
                existing.latestOrderId = order.orderId
                existing.latestPrice = order.price
                existing.latestStatus = order.status
                existing.latestStatusText = order.statusText
                existing.latestUpdatedAt = order.updatedAt
                existing.suggestedRules = suggestedRules
            }
        }

        const items = Array.from(alertsByItemId.values())
            .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt))
            .slice(0, limit)

        return c.json({ items })
    })

    // 获取单个规则
    router.get('/:id', (c) => {
        const id = parseInt(c.req.param('id'))
        const rule = getAutoSellRule(id)
        if (!rule) {
            return c.json({ error: '规则不存在' }, 404)
        }
        if (rule.deliveryType === 'stock') {
            const stats = getStockStats(id)
            return c.json({ ...rule, stockCount: stats.total, usedCount: stats.used })
        }
        return c.json(rule)
    })


    // 创建规则
    router.post('/', async (c) => {
        const body = await c.req.json()
        const id = createAutoSellRule(body)
        return c.json({ success: true, id })
    })

    // 更新规则
    router.put('/:id', async (c) => {
        const id = parseInt(c.req.param('id'))
        const body = await c.req.json()
        const success = updateAutoSellRule(id, body)
        return c.json({ success })
    })

    // 删除规则
    router.delete('/:id', (c) => {
        const id = parseInt(c.req.param('id'))
        const success = deleteAutoSellRule(id)
        return c.json({ success })
    })

    // 切换规则状态
    router.post('/:id/toggle', (c) => {
        const id = parseInt(c.req.param('id'))
        const success = toggleAutoSellRule(id)
        return c.json({ success })
    })

    // ========== 库存管理 ==========

    // 获取规则库存
    router.get('/:id/stock', (c) => {
        const id = parseInt(c.req.param('id'))
        const includeUsed = c.req.query('includeUsed') === 'true'
        const items = getStockItems(id, includeUsed)
        const stats = getStockStats(id)
        return c.json({ items, stats })
    })

    // 添加库存
    router.post('/:id/stock', async (c) => {
        const id = parseInt(c.req.param('id'))
        const body = await c.req.json()
        const contents = body.contents as string[]
        if (!Array.isArray(contents) || contents.length === 0) {
            return c.json({ error: '请提供库存内容' }, 400)
        }
        const count = addStockItems(id, contents)
        return c.json({ success: true, count })
    })

    // 清空库存
    router.delete('/:id/stock', (c) => {
        const id = parseInt(c.req.param('id'))
        const onlyUsed = c.req.query('onlyUsed') === 'true'
        const count = clearStock(id, onlyUsed)
        return c.json({ success: true, count })
    })

    // ========== 发货记录 ==========

    // 获取发货记录
    router.get('/logs', (c) => {
        const ruleId = c.req.query('ruleId')
        const orderId = c.req.query('orderId')
        const accountId = c.req.query('accountId')
        const limit = parseInt(c.req.query('limit') || '50')
        const offset = parseInt(c.req.query('offset') || '0')

        const result = getDeliveryLogs({
            ruleId: ruleId ? parseInt(ruleId) : undefined,
            orderId: orderId || undefined,
            accountId: accountId || undefined,
            limit,
            offset
        })
        return c.json(result)
    })

    return router
}
