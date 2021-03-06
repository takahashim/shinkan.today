import {join} from 'path'
import {createWriteStream, writeFileSync, readFileSync} from 'fs'
import request from 'request'
import {parse, stringify} from 'JSONStream'
import highland from 'highland'
import moment from 'moment'
import {dump} from 'js-yaml'
import summarize from './lib/summarize'

const apiRoot = 'https://api.openbd.jp/v1'
const cwd = process.cwd()
const dataDir = join(cwd, 'dist', 'data')
const bookDir = join(cwd, 'dist', 'book')
const daysBefore = 14
const daysAfter = 14
const ignoreMap = getIgnoreMap()
const indexStreams = []

const stream = highland([`${apiRoot}/coverage`])
  .flatMap(url => highland(request(url))) // openBDに問い合わせ
  .through(parse('*')) // jsonから、ISBNを取得
  .filter(isbn => !shouldIgnore(isbn))
  .batch(10000) // 10000件ごとにまとめる
  .map(isbns => ({method: 'POST', url: `${apiRoot}/get`, form: {isbn: isbns.join(',')}}))
  .flatMap(opts => highland(request(opts))) // openBDに問い合わせ
  .through(parse('*')) // jsonから、書誌情報を取得
  .map(book => summarize(book)) // 書誌情報を整形

stream.fork()
  .each(book => {
    const yaml = dump(book)
    const data = '---\n' + yaml + '\n---\n'
    writeFileSync(join(bookDir, `${book.isbn}.md`), data)
  })

stream.fork()
  .filter(book => {
    const pubdate = moment().subtract(daysBefore, 'days').format('YYYY-MM-DD')
    return book.pubdate < pubdate
  })
  .map(book => book.isbn + '\n')
  .pipe(createWriteStream(join(cwd, `ignore.txt`), {flags: 'a'})) // 追記モード

for (let n = (-1) * daysBefore; n < daysAfter; n++) {
  // 日付ごとのファイルを生成
  const pubdate = moment().add(n, 'days').format('YYYY-MM-DD')
  const subStream = stream.fork().filter(book => book.pubdate === pubdate)
  subStream.fork()
    .through(stringify())
    .pipe(createWriteStream(join(dataDir, `${pubdate}.json`)))

  // インデックス作成
  let counter = 0
  const indexStream = subStream.fork()
    .filter(book => book.cover)
    .filter(() => counter++ < 2) // .take(2) の代替
    .map(book => ({
      isbn: book.isbn,
      title: book.title,
      pubdate: book.pubdate,
      cover: book.cover
    }))
  indexStreams.push(indexStream)
}

highland(indexStreams)
  .merge()
  .group('pubdate')
  .toCallback((err, result) => {
    writeFileSync(join(dataDir, `index.json`), JSON.stringify(result))
  })

/** ignore.txt から無視すべきISBNの一覧を取得 */
function getIgnoreList () {
  try {
    return readFileSync(join(cwd, 'ignore.txt'), 'utf8').split('\n')
  } catch (e) {
    return []
  }
}

/** 存在するISBNのマップを作成する */
function getIgnoreMap () {
  return getIgnoreList().reduce((acc, cur) => {
    let ref = acc
    for (let n = 0; n < 8; n++) ref = ref[cur[n]] || (ref[cur[n]] = {})
    ref[cur[8]] = true
    return acc
  }, {})
}

/**
 * 無視すべきISBNの場合にtrueを返す
 * - 9784で始まらないもの
 * - 無視リスト(ignore.txt)に存在する
 */
function shouldIgnore (isbn) {
  if (!/^9784/.test(isbn)) return true

  const c = isbn.slice(4) // 先頭の9784を除去
  let ref = ignoreMap
  for (let n = 0; n < 9; n++) {
    ref = ref[c[n]]
    if (!ref) return false
  }
  return true
}
