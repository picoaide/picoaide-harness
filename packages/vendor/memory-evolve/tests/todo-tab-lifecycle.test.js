import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoTabLifecycle } from '../src/client/todo-tab-lifecycle.js'

test('todo tab lifecycle: disabled state disposes immediately and badge refresh cannot revive it', () => {
  let registrations = 0
  let disposals = 0
  let pokes = 0
  const lifecycle = createTodoTabLifecycle(() => {
    registrations += 1
    return () => { disposals += 1 }
  }, () => { pokes += 1 })

  lifecycle.setEnabled(true)
  lifecycle.setEnabled(false)
  lifecycle.setEnabled(false)
  // ME-1（2026-09-17 二审）：计数刷新走 setCount → poke（刷新 label 通知），
  // 停用态下既不注册也不 poke（没有条目可刷新）。
  lifecycle.setCount(3)
  assert.equal(registrations, 1)
  assert.equal(disposals, 1)
  assert.equal(pokes, 0)

  lifecycle.setEnabled(true)
  assert.equal(registrations, 2)
  // 计数变化不得重注册条目（上游条目身份 = React key，重注册会重挂视图）。
  lifecycle.setCount(4)
  assert.equal(registrations, 2)
  assert.equal(pokes, 1)
  lifecycle.dispose()
  assert.equal(disposals, 2)
})
