package serverstore

import "errors"

var (
	ErrNotFound  = errors.New("not found")
	ErrDuplicate = errors.New("duplicate")
	// ErrValidation is returned when a grant subject or resource name is
	// malformed (empty, path-ish, control chars).
	ErrValidation = errors.New("invalid value")
	// ErrLastAdmin is returned when a delete would leave zero admin accounts
	// (rolls back; see DeleteUser).
	ErrLastAdmin = errors.New("cannot delete the last admin")
)

// ErrDepartmentInUse guards department deletion when members, children or
// grant references still exist.
var ErrDepartmentInUse = errors.New("department in use")
