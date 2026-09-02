package llmgateway

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// Provider 余额查询(2026-09 用量中心 ① 总览-渠道余额卡, 设计
// docs/decisions/2026-09-02-usage-center-redesign.md):
// 用 provider 自身的 key 调上游余额 API。MVP 支持 DeepSeek 官方
// (GET /user/balance, 见 https://api-docs.deepseek.com/zh-cn/api/get-user-balance/);
// 其余协议返回 supported:false(前端置灰说明), 不做推断。
// 余额是上游账户状态:不落库、不缓存,读取时实时查询。
// ---------------------------------------------------------------------------

// balanceHTTPClient 余额查询客户端(测试可替换:httptest 本地地址)。
var balanceHTTPClient = &http.Client{Timeout: 10 * time.Second}

// balanceSupports 是否支持余额查询(DeepSeek 官方协议)。
func balanceSupports(baseURL, name string) bool {
	u := strings.ToLower(baseURL)
	n := strings.ToLower(name)
	return strings.Contains(u, "deepseek") || strings.Contains(n, "deepseek")
}

// balanceInfo 余额快照(与 DeepSeek /user/balance 的 balance_infos 对齐)。
type balanceInfo struct {
	Currency        string `json:"currency"` // CNY | USD
	TotalBalance    string `json:"total_balance"`
	GrantedBalance  string `json:"granted_balance"`
	ToppedUpBalance string `json:"topped_up_balance"`
}

// fetchDeepSeekBalance 调 DeepSeek /user/balance(空安全:is_available 不强制)。
func fetchDeepSeekBalance(baseURL, apiKey string) (bool, []balanceInfo, error) {
	base := strings.TrimRight(baseURL, "/")
	req, err := http.NewRequest(http.MethodGet, base+"/user/balance", nil)
	if err != nil {
		return false, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := balanceHTTPClient.Do(req)
	if err != nil {
		return false, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	var body struct {
		IsAvailable  bool          `json:"is_available"`
		BalanceInfos []balanceInfo `json:"balance_infos"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, nil, err
	}
	return body.IsAvailable, body.BalanceInfos, nil
}

// providerBalance GET /api/server/admin/providers/:id/balance
// 返回 {supported, is_available, infos:[{currency,total_balance,granted_balance,
// topped_up_balance}], fetched_at, error?}; provider 不存在 → 404。
func providerBalance(c *gin.Context, db *sql.DB) {
	id64, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "provider id 必须是数字")
		return
	}
	p, err := serverstore.GetGatewayProvider(db, id64)
	if err != nil {
		if err == serverstore.ErrNotFound {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "provider 不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	key, err := DecryptSecret(p.APIKeyEnc)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上游密钥解密失败")
		return
	}
	if !balanceSupports(p.BaseURL, p.Name) {
		c.JSON(http.StatusOK, gin.H{
			"supported":  false,
			"fetched_at": time.Now().Format(time.RFC3339),
		})
		return
	}
	available, infos, err := fetchDeepSeekBalance(p.BaseURL, key)
	if err != nil {
		// 上游失败:supported=true 但给出错误(前端展示"查询失败, 可重试")
		c.JSON(http.StatusOK, gin.H{
			"supported":    true,
			"is_available": false,
			"infos":        []balanceInfo{},
			"error":        err.Error(),
			"fetched_at":   time.Now().Format(time.RFC3339),
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"supported":    true,
		"is_available": available,
		"infos":        infos,
		"fetched_at":   time.Now().Format(time.RFC3339),
	})
}
