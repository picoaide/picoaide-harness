package llmgateway

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// Model is a public model exposed by an enabled provider.
type Model struct {
	ID            string `json:"id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
	// InputModalities 模型接受的输入模态(0058):'text'/'image'。客户端据此
	// 渲染图片支持与上传准入; 与桌面客户端 BootstrapConfig 对齐。
	InputModalities []string `json:"input_modalities"`
}

// ListModels returns models from enabled providers, ordered by id.
// 2026-09-23(审计 G-02):排除 catalog_missing = TRUE 的行 —— 上游目录里已经
// 没有它们了(渠道同步"停用而非删除"以保住定价),客户端目录不该再展示一个
// 选中即失败的模型。
//
// R13-GH3(`search_path` 同族第三条路径):本查询读族内关系(`models` /
// `gateway_providers`)⇒ 必须经 serverstore 的**唯一 pin 实现**读。旧实现是裸池上
// 一条未限定名查询:连接/角色/库级 search_path 前置同名 shadow schema 时,客户端
// 目录里会静默出现 shadow 的诱饵模型(真 PG + 敌对 search_path 实测)。
func ListModels(db *sql.DB) ([]Model, error) {
	ms := []Model{}
	err := serverstore.WithUsageSearchPathRead(db, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT m.name, COALESCE(m.display_name, m.name), COALESCE(m.default_params, ''),
		COALESCE(m.input_modalities, '["text"]')
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id
		WHERE p.enabled = 1 AND m.catalog_missing = FALSE ORDER BY m.id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m Model
			var modalities string
			if err := rows.Scan(&m.ID, &m.DisplayName, &m.DefaultParams, &modalities); err != nil {
				return err
			}
			m.InputModalities = serverstore.ParseInputModalities(modalities)
			ms = append(ms, m)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return ms, nil
}

// ModelEnabled reports whether id is in the model list (empty id is never enabled).
func ModelEnabled(models []Model, id string) bool {
	if id == "" {
		return false
	}
	for _, m := range models {
		if m.ID == id {
			return true
		}
	}
	return false
}

func (a *API) handleModels(c *gin.Context) {
	ms, err := ListModels(a.DB)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型列表查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"models": ms})
}
