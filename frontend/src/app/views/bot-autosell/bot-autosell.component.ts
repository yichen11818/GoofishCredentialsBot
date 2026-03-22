import { Component, OnInit, signal, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { ICONS } from '../../shared/icons';
import { DialogService } from '../../shared/dialog';
import { AutoSellService, AccountService, GoodsService, WorkflowService } from '../../core/services';
import { CodeEditorComponent } from '../../components/code-editor/code-editor.component';
import type {
    AutoSellRule, DeliveryType, TriggerOn, ApiConfig, Account, GoodsItem, StockItem, StockStats,
    Workflow, UncoveredAutoSellItemAlert, UncoveredAutoSellSuggestedRule
} from '../../core/types';

interface SkuBatchRowDraft {
    id: string;
    label: string;
    price: string;
    stockContent: string;
}

@Component({
    selector: 'app-bot-autosell',
    imports: [LucideAngularModule, FormsModule, CodeEditorComponent],
    templateUrl: './bot-autosell.html',
    styleUrl: './bot-autosell.css',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class BotAutosellComponent implements OnInit {
    private readonly service = inject(AutoSellService);
    private readonly accountService = inject(AccountService);
    private readonly goodsService = inject(GoodsService);
    private readonly workflowService = inject(WorkflowService);
    private readonly dialog = inject(DialogService);
    private readonly router = inject(Router);
    readonly icons = ICONS;

    rules = signal<AutoSellRule[]>([]);
    workflows = signal<Workflow[]>([]);
    coverageAlerts = signal<UncoveredAutoSellItemAlert[]>([]);
    loading = signal(false);
    loadingCoverageAlerts = signal(false);
    saving = signal(false);
    editingRule = signal<AutoSellRule | null>(null);
    showStockModal = signal(false);
    stockRuleId = signal<number | null>(null);
    stockItems = signal<StockItem[]>([]);
    stockStats = signal<StockStats | null>(null);
    loadingStock = signal(false);
    showUsedStock = signal(false);
    batchCreating = signal(false);
    skuBatchFloatPercent = signal(2);
    skuBatchRawText = signal('');
    skuBatchRows = signal<SkuBatchRowDraft[]>([
        { id: 'sku-batch-default', label: '', price: '', stockContent: '' }
    ]);

    // 库存编辑
    stockContent = signal('');
    editingRuleStock = computed(() => {
        const rule = this.editingRule();
        if (!rule) return { total: 0, available: 0 };
        return {
            total: rule.stockCount || 0,
            available: (rule.stockCount || 0) - (rule.usedCount || 0)
        };
    });
    stockContentCount = computed(() => {
        const content = this.stockContent();
        if (!content.trim()) return 0;
        return content.split('\n').filter(line => line.trim()).length;
    });

    // 账号和商品
    accounts = signal<Account[]>([]);
    allGoods = signal<GoodsItem[]>([]);
    loadingGoods = signal(false);
    goodsSearch = signal('');
    showGoodsDropdown = signal(false);

    filteredGoods = computed(() => {
        const search = this.goodsSearch().toLowerCase();
        const accountId = this.formData().accountId;
        const selectedItemIds = new Set(this.formData().itemIds);
        let goods = this.allGoods();

        if (accountId) {
            goods = goods.filter(g => g.accountId === accountId);
        }
        if (search) {
            goods = goods.filter(g =>
                g.title.toLowerCase().includes(search) ||
                g.id.includes(search)
            );
        }
        goods = goods.filter(g => !selectedItemIds.has(g.id));
        return goods.slice(0, 20);
    });

    skuBatchConfiguredCount = computed(() =>
        this.skuBatchRows().filter(row => row.price.trim() || row.stockContent.trim() || row.label.trim()).length
    );

    formData = signal({
        name: '',
        enabled: true,
        itemIds: [] as string[],
        accountId: null as string | null,
        minPrice: null as number | null,
        maxPrice: null as number | null,
        followUpMessage: '',
        deliveryType: 'fixed' as DeliveryType,
        deliveryContent: '',
        triggerOn: 'paid' as TriggerOn,
        workflowId: null as number | null,
        apiUrl: '',
        apiMethod: 'GET' as 'GET' | 'POST',
        apiHeaders: '',
        apiBody: '',
        apiResponseField: ''
    });

    deliveryTypes = [
        { value: 'fixed', label: '固定文本' },
        { value: 'stock', label: '库存发货' },
        { value: 'api', label: 'API取货' }
    ];

    triggerOptions = [
        { value: 'paid', label: '待发货' },
        { value: 'confirmed', label: '待收货' }
    ];

    ngOnInit() {
        this.loadRules();
        this.loadAccounts();
        this.loadAllGoods();
        this.loadWorkflows();
        this.loadCoverageAlerts();
    }

    async loadWorkflows() {
        try {
            const res = await this.workflowService.getWorkflows();
            this.workflows.set(res.workflows);
        } catch (e) {
            console.error('加载流程失败', e);
        }
    }

    async loadAccounts() {
        try {
            const res = await this.accountService.getAccounts();
            this.accounts.set(res.accounts.filter(a => a.enabled));
        } catch (e) {
            console.error('加载账号失败', e);
        }
    }

    async loadAllGoods() {
        this.loadingGoods.set(true);
        try {
            const res = await this.goodsService.getGoods();
            this.allGoods.set(res.items);
        } catch (e) {
            console.error('加载商品失败', e);
        } finally {
            this.loadingGoods.set(false);
        }
    }

    async loadRules() {
        this.loading.set(true);
        try {
            const res = await this.service.getRules();
            this.rules.set(res.rules);
            await this.loadCoverageAlerts();
        } catch (e) {
            console.error('加载规则失败', e);
        } finally {
            this.loading.set(false);
        }
    }

    async loadCoverageAlerts() {
        this.loadingCoverageAlerts.set(true);
        try {
            const res = await this.service.getCoverageAlerts({
                accountId: this.formData().accountId,
                triggerOn: this.formData().triggerOn,
                limit: 10
            });
            this.coverageAlerts.set(res.items);
        } catch (e) {
            console.error('加载未覆盖商品提示失败', e);
        } finally {
            this.loadingCoverageAlerts.set(false);
        }
    }

    onEdit(rule: AutoSellRule) {
        this.editingRule.set(rule);
        const apiConfig = rule.apiConfig;
        this.formData.set({
            name: rule.name,
            enabled: rule.enabled,
            itemIds: rule.itemIds?.length ? [...rule.itemIds] : (rule.itemId ? [rule.itemId] : []),
            accountId: rule.accountId,
            minPrice: rule.minPrice,
            maxPrice: rule.maxPrice,
            followUpMessage: rule.followUpMessage || '',
            deliveryType: rule.deliveryType,
            deliveryContent: rule.deliveryContent || '',
            triggerOn: rule.triggerOn,
            workflowId: rule.workflowId,
            apiUrl: apiConfig?.url || '',
            apiMethod: apiConfig?.method || 'GET',
            apiHeaders: apiConfig?.headers ? JSON.stringify(apiConfig.headers, null, 2) : '',
            apiBody: apiConfig?.body || '',
            apiResponseField: apiConfig?.responseField || ''
        });
        this.goodsSearch.set('');
        this.stockContent.set('');
    }

    cancelEdit() {
        this.editingRule.set(null);
        this.resetForm();
    }

    resetForm() {
        this.formData.set({
            name: '',
            enabled: true,
            itemIds: [],
            accountId: null,
            minPrice: null,
            maxPrice: null,
            followUpMessage: '',
            deliveryType: 'fixed',
            deliveryContent: '',
            triggerOn: 'paid',
            workflowId: null,
            apiUrl: '',
            apiMethod: 'GET',
            apiHeaders: '',
            apiBody: '',
            apiResponseField: ''
        });
        this.goodsSearch.set('');
        this.stockContent.set('');
    }

    updateField<K extends keyof ReturnType<typeof this.formData>>(
        field: K,
        value: ReturnType<typeof this.formData>[K]
    ) {
        this.formData.update(f => ({ ...f, [field]: value }));
        if (field === 'accountId') {
            const nextAccountId = value as string | null;
            this.formData.update(f => ({
                ...f,
                itemIds: nextAccountId
                    ? f.itemIds.filter(itemId => this.getGoodsById(itemId)?.accountId === nextAccountId)
                    : f.itemIds
            }));
            this.goodsSearch.set('');
        }
        if (field === 'accountId' || field === 'triggerOn') {
            void this.loadCoverageAlerts();
        }
    }

    selectGoods(goods: GoodsItem) {
        this.formData.update(f => {
            const itemIds = f.itemIds.includes(goods.id) ? f.itemIds : [...f.itemIds, goods.id];
            const shouldAdoptAccount = !f.accountId && f.itemIds.length === 0 && goods.accountId;
            return {
                ...f,
                itemIds,
                accountId: shouldAdoptAccount ? goods.accountId || null : f.accountId
            };
        });
        this.goodsSearch.set('');
        this.showGoodsDropdown.set(false);
    }

    removeGoodsSelection(itemId: string) {
        this.formData.update(f => ({
            ...f,
            itemIds: f.itemIds.filter(id => id !== itemId)
        }));
    }

    clearGoodsSelection() {
        this.formData.update(f => ({ ...f, itemIds: [] }));
        this.goodsSearch.set('');
    }

    onGoodsSearchFocus() {
        this.showGoodsDropdown.set(true);
    }

    onGoodsSearchBlur() {
        setTimeout(() => this.showGoodsDropdown.set(false), 200);
    }

    createSkuBatchRow(price = '', label = '', stockContent = ''): SkuBatchRowDraft {
        return {
            id: `sku_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            label,
            price,
            stockContent
        };
    }

    addSkuBatchRow(price = '', label = '', stockContent = '') {
        this.skuBatchRows.update(rows => [...rows, this.createSkuBatchRow(price, label, stockContent)]);
    }

    removeSkuBatchRow(id: string) {
        this.skuBatchRows.update(rows => {
            if (rows.length === 1) {
                return [{ ...rows[0], label: '', price: '', stockContent: '' }];
            }
            return rows.filter(row => row.id !== id);
        });
    }

    updateSkuBatchRow(id: string, field: keyof Omit<SkuBatchRowDraft, 'id'>, value: string) {
        this.skuBatchRows.update(rows =>
            rows.map(row => row.id === id ? { ...row, [field]: value } : row)
        );
    }

    loadCommonSkuTemplate() {
        this.skuBatchRows.set([
            this.createSkuBatchRow('28'),
            this.createSkuBatchRow('16.6'),
            this.createSkuBatchRow('2'),
            this.createSkuBatchRow('1')
        ]);
    }

    resetSkuBatchRows() {
        this.skuBatchRows.set([this.createSkuBatchRow()]);
        this.skuBatchFloatPercent.set(2);
        this.skuBatchRawText.set('');
    }

    onStockFileSelect(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const text = reader.result as string;
            const current = this.stockContent();
            if (current.trim()) {
                this.stockContent.set(current + '\n' + text);
            } else {
                this.stockContent.set(text);
            }
        };
        reader.readAsText(file, 'utf-8');
        input.value = '';
    }

    normalizeOptionalPrice(value: number | string | null | undefined): number | null {
        if (value === null || value === undefined || value === '') {
            return null;
        }

        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    toTextValue(value: unknown): string {
        return value === null || value === undefined ? '' : String(value);
    }

    formatNumericText(value: number | string): string {
        const price = this.normalizeOptionalPrice(value);
        if (price === null) {
            return this.toTextValue(value).trim();
        }
        return price.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    }

    getGoodsById(itemId: string): GoodsItem | undefined {
        return this.allGoods().find(g => g.id === itemId);
    }

    getGoodsTitle(itemId: string): string {
        const goods = this.getGoodsById(itemId);
        return goods?.title || itemId;
    }

    getGoodsSummary(itemIds: string[]): string {
        if (itemIds.length === 0) {
            return '未选择';
        }

        const titles = itemIds.map(itemId => this.getGoodsTitle(itemId));
        if (titles.length === 1) {
            return titles[0];
        }

        return `${titles[0]} 等 ${titles.length} 个商品`;
    }

    getRuleItemIds(rule: Pick<AutoSellRule, 'itemId' | 'itemIds'>): string[] {
        const itemIds = rule.itemIds?.length ? rule.itemIds : (rule.itemId ? [rule.itemId] : []);
        return Array.from(new Set(itemIds.map(itemId => String(itemId || '').trim()).filter(Boolean)));
    }

    getRuleGoodsSummary(rule: Pick<AutoSellRule, 'itemId' | 'itemIds'>): string {
        const itemIds = this.getRuleItemIds(rule);
        if (itemIds.length === 0) {
            return '全部商品';
        }

        return this.getGoodsSummary(itemIds);
    }

    getRuleGoodsTooltip(rule: Pick<AutoSellRule, 'itemId' | 'itemIds'>): string {
        const itemIds = this.getRuleItemIds(rule);
        if (itemIds.length === 0) {
            return '全部商品';
        }

        return itemIds.map(itemId => this.getGoodsTitle(itemId)).join('\n');
    }

    getSkuBatchBaseName(): string {
        const manualName = this.formData().name.trim();
        if (manualName) return manualName;
        const itemIds = this.formData().itemIds;
        if (itemIds.length > 0) return this.getGoodsSummary(itemIds);
        return 'SKU 自动发货';
    }

    getSkuBatchRangeByPercent(priceValue: number): { minPrice: number; maxPrice: number; delta: number } | null {
        const percent = this.normalizeOptionalPrice(this.skuBatchFloatPercent());
        if (percent === null || percent < 0) {
            return null;
        }

        const delta = Number((priceValue * percent / 100).toFixed(2));
        return {
            minPrice: Math.max(0, Number((priceValue - delta).toFixed(2))),
            maxPrice: Number((priceValue + delta).toFixed(2)),
            delta
        };
    }

    formatSkuBatchRange(priceText: string): string {
        const price = this.normalizeOptionalPrice(priceText);
        if (price === null) {
            return '输入金额后自动预览';
        }

        const range = this.getSkuBatchRangeByPercent(price);
        if (!range) {
            return '请输入有效的浮动比例';
        }

        return `¥${range.minPrice} - ¥${range.maxPrice}`;
    }

    formatSuggestedRuleRange(rule: Pick<UncoveredAutoSellSuggestedRule, 'minPrice' | 'maxPrice'>): string {
        return this.formatPriceRange(rule);
    }

    parseSkuHeader(headerText: string): { priceText: string; label: string } | null {
        const match = headerText.match(/-?\d+(?:\.\d+)?/);
        if (!match) {
            return null;
        }

        const priceText = match[0];
        const label = headerText
            .replace(priceText, '')
            .replace(/[()（）【】\[\]{}]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return { priceText, label };
    }

    async parseSkuBatchText() {
        const rawText = this.skuBatchRawText().trim();
        if (!rawText) {
            await this.dialog.alert('提示', '请先粘贴按分组整理的文本');
            return;
        }

        const lines = rawText.split(/\r?\n/);
        const rows: SkuBatchRowDraft[] = [];
        let currentHeader: { priceText: string; label: string } | null = null;
        let currentStockLines: string[] = [];

        const pushCurrentGroup = () => {
            if (!currentHeader) return;
            rows.push(this.createSkuBatchRow(
                currentHeader.priceText,
                currentHeader.label,
                currentStockLines.join('\n').trim()
            ));
        };

        for (const line of lines) {
            const trimmed = line.trim();
            const headerMatch = trimmed.match(/^[\[【](.+?)[\]】]$/);

            if (headerMatch) {
                const parsedHeader = this.parseSkuHeader(headerMatch[1].trim());
                if (!parsedHeader) {
                    await this.dialog.alert('提示', `分组标题格式无法识别：${trimmed}`);
                    return;
                }

                pushCurrentGroup();
                currentHeader = parsedHeader;
                currentStockLines = [];
                continue;
            }

            if (!currentHeader) {
                continue;
            }

            if (!trimmed) {
                continue;
            }

            currentStockLines.push(trimmed);
        }

        pushCurrentGroup();

        if (rows.length === 0) {
            await this.dialog.alert(
                '提示',
                '没有解析到任何分组。请按这种格式粘贴：\n[28]\nkey1\nkey2\n\n[16.6]\nkey3'
            );
            return;
        }

        const invalidRow = rows.find(row => !row.stockContent.trim());
        if (invalidRow) {
            await this.dialog.alert('提示', `金额 ${invalidRow.price} 的分组里没有解析到 key 库存`);
            return;
        }

        this.skuBatchRows.set(rows);
        await this.dialog.alert('成功', `已解析 ${rows.length} 个分组，你可以直接一键生成规则`);
    }

    formatPriceRange(rule: Pick<AutoSellRule, 'minPrice' | 'maxPrice'>): string {
        if (rule.minPrice !== null && rule.maxPrice !== null) {
            return `¥${rule.minPrice} - ¥${rule.maxPrice}`;
        }
        if (rule.minPrice !== null) {
            return `>= ¥${rule.minPrice}`;
        }
        if (rule.maxPrice !== null) {
            return `<= ¥${rule.maxPrice}`;
        }
        return '全部价格';
    }

    async exportUnusedStockByGroup() {
        const itemIds = this.formData().itemIds;
        if (itemIds.length === 0) {
            await this.dialog.alert('提示', '请先选择至少一个商品，再导出未使用库存');
            return;
        }

        try {
            const res = await this.service.exportUnusedStock({
                itemIds,
                accountId: this.formData().accountId,
                triggerOn: this.formData().triggerOn
            });

            if (!res.content.trim()) {
                await this.dialog.alert('提示', '当前所选商品没有可导出的未使用库存');
                return;
            }

            const fileBaseName = this.getGoodsSummary(itemIds)
                .replace(/[\\/:*?"<>|]/g, '_')
                .trim();
            const triggerLabel = this.getTriggerLabel(this.formData().triggerOn);
            const blob = new Blob([res.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${fileBaseName}-${triggerLabel}-未使用库存.txt`;
            link.click();
            URL.revokeObjectURL(url);

            await this.dialog.alert(
                '导出成功',
                `已导出 ${res.ruleCount} 个分组、共 ${res.stockCount} 条未使用库存`
            );
        } catch (e) {
            console.error('导出未使用库存失败', e);
            await this.dialog.alert('错误', '导出失败，请稍后重试');
        }
    }

    async createSkuBatchRules() {
        const data = this.formData();
        const floatPercent = this.normalizeOptionalPrice(this.skuBatchFloatPercent());
        if (floatPercent === null || floatPercent < 0) {
            await this.dialog.alert('提示', '请输入有效的浮动比例');
            return;
        }

        const preparedRows: Array<{
            rowIndex: number;
            label: string;
            price: number;
            minPrice: number;
            maxPrice: number;
            stockItems: string[];
            ruleName: string;
        }> = [];

        for (const [index, row] of this.skuBatchRows().entries()) {
            const hasAnyValue = row.price.trim() || row.stockContent.trim() || row.label.trim();
            if (!hasAnyValue) continue;

            const price = this.normalizeOptionalPrice(row.price);
            if (price === null) {
                await this.dialog.alert('提示', `第 ${index + 1} 行 SKU 金额无效`);
                return;
            }

            const stockItems = row.stockContent
                .split('\n')
                .map(item => item.trim())
                .filter(Boolean);

            if (stockItems.length === 0) {
                await this.dialog.alert('提示', `第 ${index + 1} 行还没有填写对应的 key 库存`);
                return;
            }

            const range = this.getSkuBatchRangeByPercent(price);
            if (!range) {
                await this.dialog.alert('提示', '浮动比例无效，请重新填写');
                return;
            }

            const minPrice = range.minPrice;
            const maxPrice = range.maxPrice;
            const ruleName = row.label.trim()
                ? `${this.getSkuBatchBaseName()} ${row.label.trim()}`
                : `${this.getSkuBatchBaseName()} SKU ¥${price}`;

            preparedRows.push({
                rowIndex: index + 1,
                label: row.label.trim(),
                price,
                minPrice,
                maxPrice,
                stockItems,
                ruleName
            });
        }

        if (preparedRows.length === 0) {
            await this.dialog.alert('提示', '请至少填写一行 SKU 金额和对应库存');
            return;
        }

        const sortedRows = [...preparedRows].sort((a, b) => a.minPrice - b.minPrice);
        for (let i = 1; i < sortedRows.length; i++) {
            const previous = sortedRows[i - 1];
            const current = sortedRows[i];
            if (current.minPrice <= previous.maxPrice) {
                await this.dialog.alert(
                    '提示',
                    `SKU 金额区间发生重叠：${previous.ruleName}（${previous.minPrice}-${previous.maxPrice}）和 ${current.ruleName}（${current.minPrice}-${current.maxPrice}）`
                );
                return;
            }
        }

        this.batchCreating.set(true);
        try {
            let totalStockCount = 0;
            for (const row of preparedRows) {
                const res = await this.service.createRule({
                    name: row.ruleName,
                    enabled: data.enabled,
                    itemId: data.itemIds[0] || null,
                    itemIds: data.itemIds,
                    accountId: data.accountId,
                    minPrice: row.minPrice,
                    maxPrice: row.maxPrice,
                    stockGroupLabel: row.label.trim()
                        ? `${this.formatNumericText(row.price)} ${row.label.trim()}`
                        : this.formatNumericText(row.price),
                    followUpMessage: data.followUpMessage.trim() || null,
                    deliveryType: 'stock',
                    deliveryContent: null,
                    apiConfig: null,
                    triggerOn: data.triggerOn,
                    workflowId: data.workflowId
                });

                if (!res.id) {
                    throw new Error(`第 ${row.rowIndex} 行规则创建失败`);
                }

                await this.service.addStock(res.id, row.stockItems);
                totalStockCount += row.stockItems.length;
            }

            this.skuBatchRows.update(rows =>
                rows.map(row => ({ ...row, stockContent: '' }))
            );
            await this.loadRules();
            await this.dialog.alert(
                '成功',
                `已生成 ${preparedRows.length} 条 SKU 库存规则，并导入 ${totalStockCount} 条 key 库存。当前浮动比例为 ${floatPercent}%`
            );
        } catch (e) {
            console.error('批量创建 SKU 规则失败', e);
            await this.dialog.alert('错误', '批量创建失败，请检查配置后重试');
        } finally {
            this.batchCreating.set(false);
        }
    }

    async saveRule() {
        const data = this.formData();
        if (!data.name) {
            await this.dialog.alert('提示', '请输入规则名称');
            return;
        }

        const minPrice = this.normalizeOptionalPrice(data.minPrice);
        const maxPrice = this.normalizeOptionalPrice(data.maxPrice);

        if (minPrice !== null && minPrice < 0) {
            await this.dialog.alert('提示', '最低价不能小于 0');
            return;
        }
        if (maxPrice !== null && maxPrice < 0) {
            await this.dialog.alert('提示', '最高价不能小于 0');
            return;
        }
        if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
            await this.dialog.alert('提示', '最低价不能大于最高价');
            return;
        }

        let apiConfig: ApiConfig | null = null;
        if (data.deliveryType === 'api') {
            if (!data.apiUrl) {
                await this.dialog.alert('提示', '请输入 API 地址');
                return;
            }
            let headers: Record<string, string> | undefined;
            if (data.apiHeaders) {
                try {
                    headers = JSON.parse(data.apiHeaders);
                } catch {
                    await this.dialog.alert('错误', 'Headers 格式不正确，请使用 JSON 格式');
                    return;
                }
            }
            apiConfig = {
                url: data.apiUrl,
                method: data.apiMethod,
                headers,
                body: data.apiBody || undefined,
                responseField: data.apiResponseField || undefined
            };
        }

        if (data.deliveryType === 'fixed' && !data.deliveryContent) {
            await this.dialog.alert('提示', '请输入发货内容');
            return;
        }

        const payload: Partial<AutoSellRule> = {
            name: data.name,
            enabled: data.enabled,
            itemId: data.itemIds[0] || null,
            itemIds: data.itemIds,
            accountId: data.accountId,
            minPrice,
            maxPrice,
            followUpMessage: data.deliveryType === 'stock' ? (data.followUpMessage.trim() || null) : null,
            deliveryType: data.deliveryType,
            deliveryContent: data.deliveryType === 'fixed' ? data.deliveryContent : null,
            apiConfig,
            triggerOn: data.triggerOn,
            workflowId: data.workflowId
        };

        this.saving.set(true);
        try {
            const editing = this.editingRule();
            let ruleId: number;
            if (editing) {
                await this.service.updateRule(editing.id, payload);
                ruleId = editing.id;
            } else {
                const res = await this.service.createRule(payload);
                ruleId = res.id!;
            }

            if (data.deliveryType === 'stock' && this.stockContent().trim()) {
                const contents = this.stockContent()
                    .split('\n')
                    .map(s => s.trim())
                    .filter(Boolean);
                if (contents.length > 0) {
                    await this.service.addStock(ruleId, contents);
                }
            }

            this.cancelEdit();
            await this.loadRules();
        } catch (e) {
            console.error('保存失败', e);
            await this.dialog.alert('错误', '保存失败');
        } finally {
            this.saving.set(false);
        }
    }

    async toggleRule(rule: AutoSellRule) {
        await this.service.toggleRule(rule.id);
        await this.loadRules();
    }

    async deleteRule(rule: AutoSellRule) {
        const confirmed = await this.dialog.confirm('确认删除', `确定要删除规则 "${rule.name}" 吗？`);
        if (!confirmed) return;
        await this.service.deleteRule(rule.id);
        await this.loadRules();
    }

    // 库存管理
    async openStockModal(ruleId: number) {
        this.stockRuleId.set(ruleId);
        this.showUsedStock.set(false);
        this.showStockModal.set(true);
        await this.loadStockItems();
    }

    closeStockModal() {
        this.showStockModal.set(false);
        this.stockRuleId.set(null);
        this.stockItems.set([]);
        this.stockStats.set(null);
    }

    async loadStockItems() {
        const ruleId = this.stockRuleId();
        if (!ruleId) return;

        this.loadingStock.set(true);
        try {
            const res = await this.service.getStock(ruleId, this.showUsedStock());
            this.stockItems.set(res.items);
            this.stockStats.set(res.stats);
        } catch (e) {
            console.error('加载库存失败', e);
        } finally {
            this.loadingStock.set(false);
        }
    }

    async toggleShowUsed() {
        this.showUsedStock.update(v => !v);
        await this.loadStockItems();
    }

    async clearStock(ruleId: number, onlyUsed: boolean) {
        const msg = onlyUsed ? '确定要清空已使用的库存吗？' : '确定要清空所有库存吗？';
        const confirmed = await this.dialog.confirm('确认清空', msg);
        if (!confirmed) return;

        try {
            const res = await this.service.clearStock(ruleId, onlyUsed);
            await this.loadRules();
            if (this.showStockModal()) {
                await this.loadStockItems();
            }
            await this.dialog.alert('成功', `已清空 ${res.count} 条库存`);
        } catch (e) {
            console.error('清空库存失败', e);
        }
    }

    getDeliveryTypeLabel(type: DeliveryType): string {
        return this.deliveryTypes.find(t => t.value === type)?.label || type;
    }

    getTriggerLabel(trigger: TriggerOn): string {
        return this.triggerOptions.find(t => t.value === trigger)?.label || trigger;
    }

    getWorkflowName(workflowId: number | null): string {
        if (!workflowId) return '默认流程';
        const workflow = this.workflows().find(w => w.id === workflowId);
        return workflow?.name || '默认流程';
    }

    goToWorkflowPage() {
        this.router.navigate(['/workflow']);
    }
}
