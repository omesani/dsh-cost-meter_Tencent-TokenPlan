import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { atomicWrite, commitChanges, hash, inside, planInstall, projectDir, saveBackup } from '../lib/deployment.mjs'

const temp = action => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenplan-test-'))
  try { return action(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('路径校验拒绝目录外写入', () => temp(dir => {
  assert.throws(() => inside(dir, '../outside.js'), /超出/)
  assert.throws(() => inside(dir, dir), /超出/)
  assert.equal(inside(dir, 'lib/a.js'), join(dir, 'lib/a.js'))
}))
test('原子写入失败后保留目标并清理临时文件', () => temp(dir => {
  mkdirSync(join(dir, 'target'))
  writeFileSync(join(dir, 'target/keep'), 'keep')
  assert.throws(() => atomicWrite(join(dir, 'target'), 'replacement'))
  assert.equal(readFileSync(join(dir, 'target/keep'), 'utf8'), 'keep')
  assert.deepEqual(readdirSync(dir), ['target'])
}))
test('事务在任何写入前发现并行编辑', () => temp(dir => {
  writeFileSync(join(dir, 'a'), 'old')
  writeFileSync(join(dir, 'b'), 'user edit')
  assert.throws(() => commitChanges(dir, [
    { path: 'a', before: 'old', after: 'new' }, { path: 'b', before: 'old', after: 'new' },
  ]), /文件已变化/)
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'old')
  assert.equal(readFileSync(join(dir, 'b'), 'utf8'), 'user edit')
}))
test('事务支持更新及移除本次新增文件', () => temp(dir => {
  commitChanges(dir, [{ path: 'a', before: null, after: 'hello' }])
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'hello')
  commitChanges(dir, [{ path: 'a', before: 'hello', after: null }])
  assert.deepEqual(readdirSync(dir), [])
}))
test('CLI 拒绝拼错参数而非静默执行', () => {
  const result = spawnSync(process.execPath, [join(projectDir, 'install.mjs'), '--dry-rnu'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dry-rnu/)
})

// 可选：用真实发布包做集成回归，所有写入均在临时副本内。
const releases = (process.env.TOKENPLAN_TEST_PLUGINS || '').split(',').filter(Boolean).map(path => resolve(path))
for (const source of releases) test(`发布包回归：${source}`, () => temp(root => {
  const dir = join(root, 'plugin'), home = join(root, 'home')
  cpSync(source, dir, { recursive: true, filter: path => !path.split(/[\\/]/).includes('node_modules') })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const read = path => readFileSync(join(dir, path), 'utf8')
  const cli = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
  try {
    const plan = planInstall(dir)
    assert.deepEqual(plan.errors, [])
    assert.ok(plan.changes.length > 0)
    const original = new Map(plan.changes.map(file => [file.path, file.before]))
    const backup = saveBackup(plan)
    commitChanges(dir, plan.changes)
    assert.deepEqual(planInstall(dir).changes, [], '重复安装必须零改动')

    const adapter = join(dir, 'lib/tencent-token-plan.js')
    writeFileSync(adapter, readFileSync(adapter, 'utf8') + '\n// user edit\n')
    let result = cli(join(projectDir, 'uninstall.mjs'), '--plugin', dir, '--backup', backup)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /安装后文件已变化/)
    assert.match(read('lib/tencent-token-plan.js'), /user edit/)
    writeFileSync(adapter, plan.changes.find(file => file.path === 'lib/tencent-token-plan.js').after)

    const pkg = JSON.parse(read('package.json')), savedPackage = read('package.json')
    pkg.version = '99.0.0'
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    result = cli(join(projectDir, 'uninstall.mjs'), '--plugin', dir, '--backup', backup)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /插件版本已变化/)
    writeFileSync(join(dir, 'package.json'), savedPackage)

    result = cli(join(projectDir, 'uninstall.mjs'), '--plugin', dir, '--backup', backup)
    assert.equal(result.status, 0, result.stderr)
    for (const [path, content] of original) {
      const actual = (() => { try { return read(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })()
      assert.equal(actual, content, `回退应逐字恢复 ${path}`)
    }

    const clientPath = join(dir, 'lib/client.js')
    const client = read('lib/client.js')
    writeFileSync(clientPath, client.replace('u=s.adapter==="aliyun",d=s.adapter==="tokenrhythm",m=u||d,', 'unsupported-client-shape,'))
    const before = hash(read('lib/client.js'))
    result = cli(join(projectDir, 'install.mjs'), '--plugin', dir)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /预检未通过/)
    assert.equal(hash(read('lib/client.js')), before)
    assert.equal(read('lib/custom-balance.js'), original.get('lib/custom-balance.js'))
    writeFileSync(clientPath, client)

    // 未知版本号不强行通过；只有实际结构及语法匹配时才可安装。
    const future = JSON.parse(read('package.json')); future.version = '99.0.0'
    writeFileSync(join(dir, 'package.json'), JSON.stringify(future))
    assert.deepEqual(planInstall(dir).errors, [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}))
