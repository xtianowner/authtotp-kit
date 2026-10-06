function csrfToken() {
  const match = document.cookie.match(/(?:^|; )authtotp_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export class ApiError extends Error {
  constructor(message, status, code, retryAfter = null, fields = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.fields = fields
  }
}

// FastAPI request-validation errors (422) arrive as a list whose items echo the submitted value in
// `input` — for password forms that is the password itself. Keep only the field path, error type and
// numeric limits; never turn the list into display text.
function validationFields(detail) {
  return detail.map((item) => ({
    loc: Array.isArray(item?.loc) ? item.loc.map(String) : [],
    type: typeof item?.type === 'string' ? item.type : '',
    min: Number.isFinite(item?.ctx?.min_length) ? item.ctx.min_length : undefined,
    max: Number.isFinite(item?.ctx?.max_length) ? item.ctx.max_length : undefined,
  }))
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const csrf = csrfToken()
  if (csrf && !['GET', 'HEAD'].includes(options.method || 'GET')) {
    headers.set('X-CSRF-Token', csrf)
  }
  headers.set('X-Request-ID', crypto.randomUUID())
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const retryAfterHeader = Number.parseInt(response.headers.get('Retry-After') || '', 10)
    const retryAfter = Number.isFinite(retryAfterHeader) ? retryAfterHeader : null
    if (Array.isArray(data?.detail)) {
      throw new ApiError('提交的内容不符合要求，请检查后重试。', response.status, 'VALIDATION_ERROR', retryAfter, validationFields(data.detail))
    }
    const detail = data?.error?.message || (typeof data?.detail === 'string' ? data.detail : '') || `HTTP ${response.status}`
    const code = data?.error?.code || (typeof data?.detail === 'string' ? data.detail : 'REQUEST_FAILED')
    throw new ApiError(detail, response.status, code, retryAfter)
  }
  return data
}

export const get = (path) => api(path)
export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
export const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) })
export const remove = (path, body) => api(path, { method: 'DELETE', body: JSON.stringify(body) })

