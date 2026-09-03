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
func ListModels(db *sql.DB) ([]Model, error) {
	rows, err := db.Query(`SELECT m.name, COALESCE(m.display_name, m.name), COALESCE(m.default_params, ''),
		COALESCE(m.input_modalities, '["text"]')
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id
		WHERE p.enabled = 1 ORDER BY m.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ms := []Model{}
	for rows.Next() {
		var m Model
		var modalities string
		if err := rows.Scan(&m.ID, &m.DisplayName, &m.DefaultParams, &modalities); err != nil {
			return nil, err
		}
		m.InputModalities = serverstore.ParseInputModalities(modalities)
		ms = append(ms, m)
	}
	return ms, rows.Err()
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
