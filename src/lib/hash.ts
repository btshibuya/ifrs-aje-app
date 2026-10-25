// SHA-256（ファイルや明細の指紋）。取込の読み取りライブラリと切り離し、どの画面からも軽く使えるようにする

export async function sha256(buf: ArrayBuffer | string): Promise<string> {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : buf
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
