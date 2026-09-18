// appserver 测试用的 wasm 应用一律**现场编译**（GOOS=wasip1 GOARCH=wasm），
// 不入库任何二进制（testdata 下只有 .go 源码，见 helpers_test.go 的 TestMain）。
//
// 这里刻意是**独立模块**（module picoaide.test/apps）：应用作者不会拿到平台内部包，
// 因此三个测试应用都自实现 §7 的帧协议，站在作者的位置验证契约
// （与 runtime 包的 testdata/guests 同一纪律）。
module picoaide.test/apps

go 1.26
