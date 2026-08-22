// Fixture CLI mimicking `dws auth login --device`: prints the verification
// URL + user code, keeps polling briefly, then exits 0.
console.log('● Step 1: 请求设备授权码...')
console.log('')
console.log('  链接: https://login.dingtalk.com/oauth2/device/verify.htm')
console.log('  授权码: CCBP-BNLQ')
console.log('')
console.log('  或者直接打开以下链接：')
console.log('  https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CCBP-BNLQ')
console.log('')
console.log('● Step 2: 等待用户授权...')
setTimeout(() => {
  console.log('授权完成')
  process.exit(0)
}, 500)
