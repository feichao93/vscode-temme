import fs from 'fs'
import fetch from 'node-fetch'

/** 从链接中下载 HTML */
export async function downloadHtmlFromLink(url: string) {
  let isFileLink = false
  // TODO 处理不同类型的链接
  // http/https 链接: https://zhihu.com/xxx/yy
  // files 链接   file:///D:\workspace\temme\....
  // 相对路径链接  a.html
  // 相对路径链接  ../parent-dir/sub-dir/foo.html

  if (url.startsWith('file:///')) {
    url = url.replace('file:///', '')
    isFileLink = true
  }

  if (isFileLink) {
    return fs.readFileSync(url, 'utf8')
  } else {
    const response = await fetch(url)
    if (response.ok) {
      return await response.text()
    } else {
      throw new Error(`Cannot download html from ${url}`)
    }
  }
}
