import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/transport.ts', import.meta.url), 'utf8')
const bundle = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

test('published transport scopes insecure TLS to Huawei requests', () => {
  for (const text of [source, bundle]) {
    assert.match(text, /EnvHttpProxyAgent/)
    assert.match(text, /requestTls:\s*\{\s*rejectUnauthorized:\s*false\s*\}/)
    assert.match(text, /\.endsWith\(`\.\$\{HUAWEI_DOMAIN\}`\)/)
    assert.doesNotMatch(text, /NODE_TLS_REJECT_UNAUTHORIZED/)
    assert.doesNotMatch(text, /appendFileSync|readFileSync\(['"]\/etc\/hosts/)
  }
})

test('all provider network calls use the scoped transport', async () => {
  const tokenManager = await readFile(new URL('../src/token-manager.ts', import.meta.url), 'utf8')
  const adapter = await readFile(new URL('../src/adapter.ts', import.meta.url), 'utf8')
  const modelCatalog = await readFile(new URL('../src/model-catalog.ts', import.meta.url), 'utf8')
  assert.equal(tokenManager.match(/huaweiFetch\(/g)?.length, 1)
  assert.equal(adapter.match(/huaweiFetch\(/g)?.length, 2)
  assert.equal(modelCatalog.match(/huaweiFetch\(/g)?.length, 2)
  assert.doesNotMatch(tokenManager, /\bfetch\(/)
  assert.doesNotMatch(adapter, /\bfetch\(/)
  assert.doesNotMatch(modelCatalog, /\bfetch\(/)
})

test('published bundle uses the CodeAgent CLI catalog rather than guessing a models path', () => {
  assert.match(bundle, /codeagentcli\.rnd\.huawei\.com\/codeAgentPro\/chat\/modles/)
  assert.match(bundle, /codeAgentPro\/auth\/internal\/getUserDetail/)
  assert.match(bundle, /checkUserPermission/)
  assert.match(bundle, /routModels/)
  assert.match(bundle, /modalities/)
  assert.doesNotMatch(bundle, /chat\\\/completions.*models/)
})
