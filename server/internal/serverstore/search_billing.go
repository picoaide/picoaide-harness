package serverstore

import (
	"math"
	"strconv"
	"strings"
)

// SearchPriceSetting 是 web_search 按次计费的价目（元 / 千次成功请求）。
//
// 为什么是全局设置而不是模型价：DeepSeek 官方的 Search 费用与模型无关
// （统一 5 元 / 千次成功请求，见 https://api-docs.deepseek.com/zh-cn/guides/search），
// 且 2026-11-01 00:00（北京时间）起对 DeepSeek Harness / Claude Code / Codex
// 经 Server 端工具调用的 Search 开始计费。放到 settings 与峰谷窗口同层级，
// 改价只影响之后产生的 usage 行（cost 在记录时固化）。
//
// 取值语义：
//
//	缺省 / 空串 / "0" = 不计费（升级后默认不改变既有账单）；
//	>0               = 每次成功搜索增加 price/1000 元；
//	非法值           = 读取侧按 0 处理（fail-safe：不凭空多收），写入侧 400。
const SearchPriceSetting = "usage.search_price_per_1k"

// MaxSearchPricePer1K 是管理端可配置上限（元/千次）。
//
// 官方当前价 5 元/千次；留出 200 倍余量给渠道/中转定价，同时挡住误填天文数字
// 把一次搜索算成几十元。
const MaxSearchPricePer1K = 1000

// ParseSearchPricePer1K 解析并校验 Search 单价（元/千次）。
//
// 空串合法（= 0，不计费）；负数、NaN/Inf、非数字、超过上限一律 ok=false。
// 读取侧（计价）与写入侧（管理端 PUT）共用这一份口径。
func ParseSearchPricePer1K(raw string) (float64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, true
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > MaxSearchPricePer1K {
		return 0, false
	}
	return v, true
}

// searchFee 是 web_search 按次费用的**唯一实现**：
// 次数 × 单价(元/千次) / 1000。负次数/负单价一律 0（与 token 计费的
// clamp 同向：上游可控数据不得产生负费用）。
//
// 注意：调用方必须把它**加在**峰谷系数之后 —— Search 是独立价目，官方没有
// 峰谷差异，不能跟着模型 token 一起打折。
func searchFee(requests int64, per1K float64) float64 {
	if requests <= 0 || per1K <= 0 {
		return 0
	}
	return float64(requests) / 1000 * per1K
}
