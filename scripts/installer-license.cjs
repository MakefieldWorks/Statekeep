// electron-builder beforePack hook. The Windows installer's license page shows
// a plain-text box that wraps lines itself, so the 80-column hard wraps in the
// repository's LICENSE break sentences mid-line there. This writes a copy with
// each paragraph joined onto one line (blank lines between paragraphs kept)
// for nsis.license in electron-builder.yml to point at. LICENSE itself stays
// as it is.

const { mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, join } = require('path')

const OUTPUT = join('dist', 'installer-license.txt')

function unwrapParagraphs(text) {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .join(' '),
    )
    .join('\r\n\r\n') + '\r\n'
}

exports.unwrapParagraphs = unwrapParagraphs

exports.default = async function writeInstallerLicense(context) {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.info.projectDir
  const target = join(projectDir, OUTPUT)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, unwrapParagraphs(readFileSync(join(projectDir, 'LICENSE'), 'utf8')))
}
