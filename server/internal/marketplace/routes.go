package marketplace

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes mounts /api/marketplace/* endpoints.
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	NewAPI(db, cacheDir).RegisterRoutes(r)
}
