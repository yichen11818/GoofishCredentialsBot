/**
 * 自动发货 API 路由
 */

import { Hono } from 'hono'

import {
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

export function createAutoSellRoutes() {
    const router = new Hono()

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
        const itemId = c.req.query('itemId')
        const accountId = c.req.query('accountId') || undefined
        const triggerOn = c.req.query('triggerOn') || undefined

        if (!itemId) {
            return c.json({ error: '请提供商品 ID' }, 400)
        }

        const matchedRules = getAutoSellRules()
            .filter(rule => rule.deliveryType === 'stock')
            .filter(rule => rule.itemId === itemId)
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
