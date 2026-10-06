export async function decodeQrFile(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('请选择二维码图片。')
  if (file.size > 8 * 1024 * 1024) throw new Error('二维码图片不能超过 8 MB。')
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const { default: jsQR } = await import('jsqr')
  const decoded = jsQR(pixels.data, pixels.width, pixels.height, {
    inversionAttempts: 'attemptBoth',
  })
  if (!decoded?.data) throw new Error('没有识别到二维码，请使用更清晰的截图或改为粘贴设置密钥。')
  let parsed
  try { parsed = new URL(decoded.data) }
  catch { throw new Error('二维码已识别，但内容不是有效的 TOTP 绑定地址。') }
  if (parsed.protocol !== 'otpauth:' || parsed.host.toLowerCase() !== 'totp') {
    throw new Error('这个二维码不是标准 TOTP 绑定二维码。')
  }
  if (!parsed.searchParams.has('secret')) {
    throw new Error('二维码已识别，但内容缺少 TOTP 密钥。请回到平台重新发起绑定。')
  }
  if (!parsed.searchParams.get('secret')?.trim()) {
    throw new Error('二维码已识别，但其中的 TOTP 密钥为空。请回到平台刷新或重新发起绑定。')
  }
  return decoded.data
}
