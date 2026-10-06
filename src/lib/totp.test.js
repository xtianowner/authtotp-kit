import assert from 'node:assert/strict'
import test from 'node:test'
import { generateTotp, normalizeBase32Secret, secondsRemaining } from './totp.js'

// RFC 6238 Appendix B: the same timestamps exercise SHA-1, SHA-256, and SHA-512.
const vectors = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
]

const secrets = {
  SHA1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  SHA256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====',
  SHA512: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA=',
}

for (const [index, algorithm] of ['SHA1', 'SHA256', 'SHA512'].entries()) {
  test(`RFC 6238 ${algorithm} vectors`, async () => {
    for (const vector of vectors) {
      const code = await generateTotp({
        secret: secrets[algorithm],
        time: vector[0] * 1000,
        period: 30,
        digits: 8,
        algorithm,
      })
      assert.equal(code, vector[index + 1])
    }
  })
}

test('normalizes presentation whitespace without persisting it', () => {
  assert.equal(normalizeBase32Secret(' jbsw y3dp ehpk 3pxp= '), 'JBSWY3DPEHPK3PXP')
})

test('reports the standard 30-second window', () => {
  assert.equal(secondsRemaining(0, 30), 30)
  assert.equal(secondsRemaining(29_000, 30), 1)
  assert.equal(secondsRemaining(30_000, 30), 30)
})
