const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const HASH_NAMES = {
  SHA1: 'SHA-1',
  'SHA-1': 'SHA-1',
  SHA256: 'SHA-256',
  'SHA-256': 'SHA-256',
  SHA512: 'SHA-512',
  'SHA-512': 'SHA-512',
}

export function normalizeBase32Secret(secret) {
  return String(secret ?? '').replace(/\s+/g, '').replace(/=+$/g, '').toUpperCase()
}

export function decodeBase32(secret) {
  const normalized = normalizeBase32Secret(secret)
  if (!normalized) throw new Error('EMPTY_SECRET')
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error('INVALID_BASE32')

  let bits = 0
  let buffer = 0
  const bytes = []
  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 0xff)
    }
  }
  if (!bytes.length) throw new Error('INVALID_BASE32')
  return new Uint8Array(bytes)
}

function counterBytes(counter) {
  const bytes = new Uint8Array(8)
  let value = BigInt(counter)
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn)
    value >>= 8n
  }
  return bytes
}

export async function generateTotp({
  secret,
  time = Date.now(),
  period = 30,
  digits = 6,
  algorithm = 'SHA1',
} = {}) {
  const hash = HASH_NAMES[String(algorithm).toUpperCase()]
  if (!hash) throw new Error('UNSUPPORTED_ALGORITHM')
  if (!Number.isInteger(period) || period <= 0) throw new Error('INVALID_PERIOD')
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error('INVALID_DIGITS')

  const keyBytes = decodeBase32(secret)
  const counter = Math.floor(Number(time) / 1000 / period)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: { name: hash } },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)))
  const offset = digest[digest.length - 1] & 0x0f
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0
  return String(binary % (10 ** digits)).padStart(digits, '0')
}

export function secondsRemaining(time = Date.now(), period = 30) {
  const elapsed = Math.floor(Number(time) / 1000) % period
  return period - elapsed
}
