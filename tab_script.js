//--------------------------------------------
/*! streamsaver. MIT License. Jimmy Wärting <https://jimmy.warting.se/opensource> */

/* global chrome location ReadableStream define MessageChannel TransformStream */

  const global = typeof window === 'object' ? window : this
  if (!global.HTMLElement) console.warn('streamsaver is meant to run on browsers main thread')

  let mitmTransporter = null
  let supportsTransferable = false
  const test = fn => { try { fn() } catch (e) {} }
  const ponyfill = global.WebStreamsPolyfill || {}
  const isSecureContext = global.isSecureContext
  // TODO: Must come up with a real detection test (#69)
  let useBlobFallback = /constructor/i.test(global.HTMLElement) || !!global.safari || !!global.WebKitPoint
  const downloadStrategy = isSecureContext || 'MozAppearance' in document.documentElement.style
    ? 'iframe'
    : 'navigate'

  const streamSaver = {
    createWriteStream,
    WritableStream: global.WritableStream || ponyfill.WritableStream,
    supported: true,
    version: { full: '2.0.5', major: 2, minor: 0, dot: 5 },
    mitm: 'https://jimmywarting.github.io/StreamSaver.js/mitm.html?version=2.0.0'
  }

  /**
   * create a hidden iframe and append it to the DOM (body)
   *
   * @param  {string} src page to load
   * @return {HTMLIFrameElement} page to load
   */
  function makeIframe (src) {
    if (!src) throw new Error('meh')
    const iframe = document.createElement('iframe')
    iframe.hidden = true
    iframe.src = src
    iframe.loaded = false
    iframe.name = 'iframe'
    iframe.isIframe = true
    iframe.postMessage = (...args) => iframe.contentWindow.postMessage(...args)
    iframe.addEventListener('load', () => {
      iframe.loaded = true
    }, { once: true })
    document.body.appendChild(iframe)
    return iframe
  }

  /**
   * create a popup that simulates the basic things
   * of what a iframe can do
   *
   * @param  {string} src page to load
   * @return {object}     iframe like object
   */
  function makePopup (src) {
    const options = 'width=200,height=100'
    const delegate = document.createDocumentFragment()
    const popup = {
      frame: global.open(src, 'popup', options),
      loaded: false,
      isIframe: false,
      isPopup: true,
      remove () { popup.frame.close() },
      addEventListener (...args) { delegate.addEventListener(...args) },
      dispatchEvent (...args) { delegate.dispatchEvent(...args) },
      removeEventListener (...args) { delegate.removeEventListener(...args) },
      postMessage (...args) { popup.frame.postMessage(...args) }
    }

    const onReady = evt => {
      if (evt.source === popup.frame) {
        popup.loaded = true
        global.removeEventListener('message', onReady)
        popup.dispatchEvent(new Event('load'))
      }
    }

    global.addEventListener('message', onReady)

    return popup
  }

  try {
    // We can't look for service worker since it may still work on http
    new Response(new ReadableStream())
    if (isSecureContext && !('serviceWorker' in navigator)) {
      useBlobFallback = true
    }
  } catch (err) {
    useBlobFallback = true
  }

  test(() => {
    // Transferable stream was first enabled in chrome v73 behind a flag
    const { readable } = new TransformStream()
    const mc = new MessageChannel()
    mc.port1.postMessage(readable, [readable])
    mc.port1.close()
    mc.port2.close()
    supportsTransferable = true
    // Freeze TransformStream object (can only work with native)
    Object.defineProperty(streamSaver, 'TransformStream', {
      configurable: false,
      writable: false,
      value: TransformStream
    })
  })

  function loadTransporter () {
    if (!mitmTransporter) {
      mitmTransporter = isSecureContext
        ? makeIframe(streamSaver.mitm)
        : makePopup(streamSaver.mitm)
    }
  }

  /**
   * @param  {string} filename filename that should be used
   * @param  {object} options  [description]
   * @param  {number} size     deprecated
   * @return {WritableStream<Uint8Array>}
   */
  function createWriteStream (filename, options, size) {
    let opts = {
      size: null,
      pathname: null,
      writableStrategy: undefined,
      readableStrategy: undefined
    }

    let bytesWritten = 0 // by StreamSaver.js (not the service worker)
    let downloadUrl = null
    let channel = null
    let ts = null

    // normalize arguments
    if (Number.isFinite(options)) {
      [ size, options ] = [ options, size ]
      console.warn('[StreamSaver] Deprecated pass an object as 2nd argument when creating a write stream')
      opts.size = size
      opts.writableStrategy = options
    } else if (options && options.highWaterMark) {
      console.warn('[StreamSaver] Deprecated pass an object as 2nd argument when creating a write stream')
      opts.size = size
      opts.writableStrategy = options
    } else {
      opts = options || {}
    }
    if (!useBlobFallback) {
      loadTransporter()

      channel = new MessageChannel()

      // Make filename RFC5987 compatible
      filename = encodeURIComponent(filename.replace(/\//g, ':'))
        .replace(/['()]/g, escape)
        .replace(/\*/g, '%2A')

      const response = {
        transferringReadable: supportsTransferable,
        pathname: opts.pathname || Math.random().toString().slice(-6) + '/' + filename,
        headers: {
          'Content-Type': 'application/octet-stream; charset=utf-8',
          'Content-Disposition': "attachment; filename*=UTF-8''" + filename
        }
      }

      if (opts.size) {
        response.headers['Content-Length'] = opts.size
      }

      const args = [ response, '*', [ channel.port2 ] ]

      if (supportsTransferable) {
        const transformer = downloadStrategy === 'iframe' ? undefined : {
          // This transformer & flush method is only used by insecure context.
          transform (chunk, controller) {
            if (!(chunk instanceof Uint8Array)) {
              throw new TypeError('Can only write Uint8Arrays')
            }
            bytesWritten += chunk.length
            controller.enqueue(chunk)

            if (downloadUrl) {
              location.href = downloadUrl
              downloadUrl = null
            }
          },
          flush () {
            if (downloadUrl) {
              location.href = downloadUrl
            }
          }
        }
        ts = new streamSaver.TransformStream(
          transformer,
          opts.writableStrategy,
          opts.readableStrategy
        )
        const readableStream = ts.readable

        channel.port1.postMessage({ readableStream }, [ readableStream ])
      }

      channel.port1.onmessage = evt => {
        // Service worker sent us a link that we should open.
        if (evt.data.download) {
          // Special treatment for popup...
          if (downloadStrategy === 'navigate') {
            mitmTransporter.remove()
            mitmTransporter = null
            if (bytesWritten) {
              location.href = evt.data.download
            } else {
              downloadUrl = evt.data.download
            }
          } else {
            if (mitmTransporter.isPopup) {
              mitmTransporter.remove()
              mitmTransporter = null
              // Special case for firefox, they can keep sw alive with fetch
              if (downloadStrategy === 'iframe') {
                makeIframe(streamSaver.mitm)
              }
            }

            // We never remove this iframes b/c it can interrupt saving
            makeIframe(evt.data.download)
          }
        } else if (evt.data.abort) {
          chunks = []
          channel.port1.postMessage('abort') //send back so controller is aborted
          channel.port1.onmessage = null
          channel.port1.close()
          channel.port2.close()
          channel = null
        }
      }

      if (mitmTransporter.loaded) {
        mitmTransporter.postMessage(...args)
      } else {
        mitmTransporter.addEventListener('load', () => {
          mitmTransporter.postMessage(...args)
        }, { once: true })
      }
    }

    let chunks = []

    return (!useBlobFallback && ts && ts.writable) || new streamSaver.WritableStream({
      write (chunk) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Can only write Uint8Arrays')
        }
        if (useBlobFallback) {
          // Safari... The new IE6
          // https://github.com/jimmywarting/StreamSaver.js/issues/69
          //
          // even though it has everything it fails to download anything
          // that comes from the service worker..!
          chunks.push(chunk)
          return
        }

        // is called when a new chunk of data is ready to be written
        // to the underlying sink. It can return a promise to signal
        // success or failure of the write operation. The stream
        // implementation guarantees that this method will be called
        // only after previous writes have succeeded, and never after
        // close or abort is called.

        // TODO: Kind of important that service worker respond back when
        // it has been written. Otherwise we can't handle backpressure
        // EDIT: Transferable streams solves this...
        channel.port1.postMessage(chunk)
        bytesWritten += chunk.length

        if (downloadUrl) {
          location.href = downloadUrl
          downloadUrl = null
        }
      },
      close () {
        if (useBlobFallback) {
          const blob = new Blob(chunks, { type: 'application/octet-stream; charset=utf-8' })
          const link = document.createElement('a')
          link.href = URL.createObjectURL(blob)
          link.download = filename
          link.click()
        } else {
          channel.port1.postMessage('end')
        }
      },
      abort () {
        chunks = []
        channel.port1.postMessage('abort')
        channel.port1.onmessage = null
        channel.port1.close()
        channel.port2.close()
        channel = null
      }
    }, opts.writableStrategy)
  }

//--------------------------------------------
deps = {'1673': {'name': 'ישראל הקדום', 'faculty': ''},
 '1622': {'name': 'היסטוריה של המזרח התיכון ואפרי', 'faculty': ''},
 '1662': {'name': 'תכנית הלימודים הרב-תחומית', 'faculty': ''},
 '1643': {'name': 'ארכיונאות ומידענות', 'faculty': ''},
 '1659': {'name': 'היסטוריה ופילוסופיה של המדעים', 'faculty': ''},
 '0881': {'name': 'ביה"ס לאדריכלות', 'faculty': 'אמנויות'},
 '0843': {'name': 'ביה"ס למוזיקה-מגמה לקומפוזיציה', 'faculty': 'אמנויות'},
 '0853': {'name': 'לימודי הכשרה בקולנוע וטלוויזיה', 'faculty': 'אמנויות'},
 '0851': {'name': 'ביה"ס לקולנוע וטלוויזיה', 'faculty': 'אמנויות'},
 '0842': {'name': 'ביה"ס למוזיקה-המגמה לבצוע מוזי', 'faculty': 'אמנויות'},
 '0821': {'name': 'תולדות האמנות', 'faculty': 'אמנויות'},
 '0811': {'name': 'אמנות התיאטרון', 'faculty': 'אמנויות'},
 '0810': {'name': 'התכנית הבינתחומית באמנויות', 'faculty': 'אמנויות'},
 '0809': {'name': 'לימודי העשרה', 'faculty': 'אמנויות'},
 '0845': {'name': 'ביה"ס למוזיקה-מגמת מוזיקולוגיה', 'faculty': 'אמנויות'},
 '0861': {'name': 'התכנית הרב-תחומית באמנויות', 'faculty': 'אמנויות'},
 '0510': {'name': 'בית הספר להנדסת חשמל', 'faculty': 'הנדסה'},
 '0545': {'name': 'הנדסת סביבה', 'faculty': 'הנדסה'},
 '0553': {'name': 'מחלקה להנדסה ביו-רפואית', 'faculty': 'הנדסה'},
 '0542': {'name': 'מגמה להנדסה מכנית', 'faculty': 'הנדסה'},
 '0512': {'name': 'מגמה להנדסת חשמל', 'faculty': 'הנדסה'},
 '0572': {'name': 'הנדסה תעשייה', 'faculty': 'הנדסה'},
 '0560': {'name': 'מדעים דיגיטליים להיי-טק', 'faculty': 'הנדסה'},
 '0571': {'name': 'מגמה להנדסת תעשייה', 'faculty': 'הנדסה'},
 '0509': {'name': 'קורסי תשתית ובחירה', 'faculty': 'הנדסה'},
 '0581': {'name': 'מדע והנדסה של חומרים', 'faculty': 'הנדסה'},
 '0555': {'name': 'המגמה להנדסה ביו-רפואית', 'faculty': 'הנדסה'},
 '0540': {'name': 'בית הספר להנדסה מכנית', 'faculty': 'הנדסה'},
 '0546': {'name': 'הנדסת מערכות', 'faculty': 'הנדסה'},
 '0719': {'name': 'לקויות למידה', 'faculty': 'חינוך'},
 '0722': {'name': 'מדיניות ומינהל בחינוך', 'faculty': 'חינוך'},
 '0721': {'name': 'היבטים התפתחותיים בחינוך', 'faculty': 'חינוך'},
 '0712': {'name': 'ייעוץ חינוכי', 'faculty': 'חינוך'},
 '0709': {'name': 'חוגי בית הספר לחינוך', 'faculty': 'חינוך'},
 '0711': {'name': 'מדעי החינוך', 'faculty': 'חינוך'},
 '0769': {'name': 'יחידה להכשרה להוראה', 'faculty': 'חינוך'},
 '0757': {'name': 'מגמה להוראת המדעים', 'faculty': 'חינוך'},
 '0776': {'name': 'מינהל ומנהיגות בחינוך', 'faculty': 'חינוך'},
 '0738': {'name': 'תכנון לימודים והוראה', 'faculty': 'חינוך'},
 '0723': {'name': 'חינוך', 'faculty': 'חינוך'},
 '2172': {'name': 'לימודי שפות', 'faculty': 'יחידות מיוחדות'},
 '2171': {'name': 'לימודי אנגלית כשפה זרה', 'faculty': 'יחידות מיוחדות'},
 '1500': {'name': 'בית הספר למדעי המוח', 'faculty': 'לימודי המוח'},
 '1501': {'name': 'מדעי המוח', 'faculty': 'לימודי המוח'},
 '0920': {'name': 'תכנית בינלאומית בלימודי הסביבה',
  'faculty': 'לימודי הסביבה'},
 '0910': {'name': 'בית הספר ללימודי הסביבה', 'faculty': 'לימודי הסביבה'},
 '1046': {'name': 'ניהול סכסוכים וגישור', 'faculty': 'מדעי החברה'},
 '1033': {'name': 'מדע המדינה - דיפלומטיה וביטחון', 'faculty': 'מדעי החברה'},
 '1085': {'name': 'תקשורת', 'faculty': 'מדעי החברה'},
 '1035': {'name': 'לימודי דיפלומטיה', 'faculty': 'מדעי החברה'},
 '1044': {'name': 'יישוב סכסוכים וגישור', 'faculty': 'מדעי החברה'},
 '1051': {'name': 'לימודי עבודה', 'faculty': 'מדעי החברה'},
 '1071': {'name': 'פסיכולוגיה', 'faculty': 'מדעי החברה'},
 '1031': {'name': 'מדע המדינה', 'faculty': 'מדעי החברה'},
 '1092': {'name': 'ארצות מתפתחות', 'faculty': 'מדעי החברה'},
 '1082': {'name': 'מדיניות ציבורית', 'faculty': 'מדעי החברה'},
 '1009': {'name': 'חוגי מדעי החברה - כללי', 'faculty': 'מדעי החברה'},
 '1052': {'name': 'לימודי ביטחון', 'faculty': 'מדעי החברה'},
 '1036': {'name': 'לימודי הגירה', 'faculty': 'מדעי החברה'},
 '1041': {'name': 'סוציולוגיה ואנתרופולוגיה', 'faculty': 'מדעי החברה'},
 '1020': {'name': 'לימודי פוליטיקה, סייבר וממשל', 'faculty': 'מדעי החברה'},
 '1011': {'name': 'כלכלה', 'faculty': 'מדעי החברה'},
 '0411': {'name': 'בית הספר למדעי הצמח ואבטחת מזו', 'faculty': 'מדעי החיים'},
 '0440': {'name': 'מחקר ביו-רפואי ולחקר הסרטן ע"', 'faculty': 'מדעי החיים'},
 '0453': {'name': 'מיקרוביולוגיה מולקולרית וביוטכ', 'faculty': 'מדעי החיים'},
 '0431': {'name': 'בית הספר לזואולוגיה', 'faculty': 'מדעי החיים'},
 '0455': {'name': 'ביולוגיה', 'faculty': 'מדעי החיים'},
 '0491': {'name': 'מחלקה לנוירוביולוגיה', 'faculty': 'מדעי החיים'},
 '0421': {'name': 'מחלקה לביוכימיה וביולוגיה מולק', 'faculty': 'מדעי החיים'},
 '0400': {'name': 'פקולטה למדעי החיים', 'faculty': 'מדעי החיים'},
 '0368': {'name': 'מדעי המחשב', 'faculty': 'מדעים מדויקים'},
 '0351': {'name': 'כימיה', 'faculty': 'מדעים מדויקים'},
 '0349': {'name': 'גאוגרפיה וסביבת האדם', 'faculty': 'מדעים מדויקים'},
 '0372': {'name': 'מגמה למתמטיקה שימושית', 'faculty': 'מדעים מדויקים'},
 '0321': {'name': 'פיזיקה', 'faculty': 'מדעים מדויקים'},
 '0341': {'name': 'גאופיזיקה', 'faculty': 'מדעים מדויקים'},
 '0300': {'name': 'פקולטה למדעים מדויקים', 'faculty': 'מדעים מדויקים'},
 '0366': {'name': 'מתמטיקה', 'faculty': 'מדעים מדויקים'},
 '0365': {'name': 'סטטיסטיקה וחקר ביצועים', 'faculty': 'מדעים מדויקים'},
 '1493': {'name': 'משפטים- תכנית בינלאומית', 'faculty': 'משפטים'},
 '1411': {'name': 'משפטים', 'faculty': 'משפטים'},
 '1211': {'name': 'חשבונאות', 'faculty': 'ניהול'},
 '1242': {'name': 'מדעי הניהול-טכנולוגיה ומערכות', 'faculty': 'ניהול'},
 '1261': {'name': 'מנהל עסקים-התמחות בנהול פיננסי', 'faculty': 'ניהול'},
 '1238': {'name': 'תכנית מב"ע בינלאומית', 'faculty': 'ניהול'},
 '1231': {'name': 'מנהל עסקים', 'faculty': 'ניהול'},
 '1221': {'name': 'ניהול 1221', 'faculty': 'ניהול'},
 '1264': {'name': 'מב"ע-התמ\' בנהול טכנולוגיה,יזמו', 'faculty': 'ניהול'},
 '1243': {'name': 'מדעי הניהול-התנהגות ארגונית', 'faculty': 'ניהול'},
 '1233': {'name': 'מנהל מערכות בריאות', 'faculty': 'ניהול'},
 '1110': {'name': 'ביה"ס לעבודה סוציאלית', 'faculty': 'עבודה סוציאלית'},
 '0669': {'name': 'מחקר התרבות', 'faculty': 'רוח'},
 '0618': {'name': 'פילוסופיה', 'faculty': 'רוח'},
 '0645': {'name': 'ביה"ס להיסטוריה', 'faculty': 'רוח'},
 '0697': {'name': 'מדעי הדתות', 'faculty': 'רוח'},
 '0662': {'name': 'התכנית הרב תחומית במדעי הרוח', 'faculty': 'רוח'},
 '0688': {'name': 'לימודים קוגניטיביים של השפה', 'faculty': 'רוח'},
 '0693': {'name': 'לימודי אפריקה-בתכנית בין אוניב', 'faculty': 'רוח'},
 '0608': {'name': 'לימודי נשים ומגדר', 'faculty': 'רוח'},
 '0620': {'name': 'ביה"ס למדעי-התרבות', 'faculty': 'רוח'},
 '0699': {'name': 'עריכה לשונית', 'faculty': 'רוח'},
 '0641': {'name': 'ביה"ס למדעי היהדות וארכיאולוג', 'faculty': 'רוח'},
 '0677': {'name': 'היסטוריה של עם ישראל', 'faculty': 'רוח'},
 '0672': {'name': 'לימודים קלאסיים', 'faculty': 'רוח'},
 '0659': {'name': 'היסטוריה ופילוסופיה של המדעים', 'faculty': 'רוח'},
 '0616': {'name': 'פילוסופיה יהודית', 'faculty': 'רוח'},
 '0687': {'name': 'לימודי מזרח אסיה', 'faculty': 'רוח'},
 '0651': {'name': 'פילוסופיה, כלכלה ומדע המדינה', 'faculty': 'רוח'},
 '0622': {'name': 'היסטוריה של המזרח התיכון ואפרי', 'faculty': 'רוח'},
 '0612': {'name': 'מקרא', 'faculty': 'רוח'},
 '0621': {'name': 'היסטוריה כללית', 'faculty': 'רוח'},
 '0668': {'name': 'מגמה לתרבות צרפת', 'faculty': 'רוח'},
 '0626': {'name': 'אנגלית', 'faculty': 'רוח'},
 '0671': {'name': 'ארכיאולוגיה ותרבויות המזרח הקד', 'faculty': 'רוח'},
 '0654': {'name': 'היסטוריה של המזה"ת ואפריקה', 'faculty': 'רוח'},
 '0614': {'name': 'החוג ללשון העברית', 'faculty': 'רוח'},
 '0627': {'name': 'בלשנות', 'faculty': 'רוח'},
 '0680': {'name': 'ספרות', 'faculty': 'רוח'},
 '0607': {'name': 'לימודי מגדר', 'faculty': 'רוח'},
 '0631': {'name': 'לימודי הערבית והאסלאם', 'faculty': 'רוח'},
 '0624': {'name': 'בלשנות שמית', 'faculty': 'רוח'},
 '0609': {'name': 'חוגי מדעי הרוח', 'faculty': 'רוח'},
 '0149': {'name': 'ניהול מצבי חירום ואסון', 'faculty': 'רפואה'},
 '0104': {'name': 'מדעי החיים ומדעי הרפואה', 'faculty': 'רפואה'},
 '0148': {'name': 'פיזיולוגיה של המאמץ', 'faculty': 'רפואה'},
 '0141': {'name': 'ביולוגיה תאית והתפתחותית', 'faculty': 'רפואה'},
 '0163': {'name': 'סיעוד', 'faculty': 'רפואה'},
 '0111': {'name': 'ביה"ס לרפואה', 'faculty': 'רפואה'},
 '0159': {'name': 'בריאות תעסוקתית', 'faculty': 'רפואה'},
 '0164': {'name': 'פיזיותרפיה', 'faculty': 'רפואה'},
 '0158': {'name': 'אפידמיולגיה', 'faculty': 'רפואה'},
 '0191': {'name': 'ביה"ס לרפואת שיניים', 'faculty': 'רפואה'},
 '0117': {'name': 'פתולוגיה', 'faculty': 'רפואה'},
 '0146': {'name': 'בריאות הציבור', 'faculty': 'רפואה'},
 '0102': {'name': 'ביה"ס לרפואה לבעלי תואר ראשון', 'faculty': 'רפואה'},
 '0150': {'name': 'ניהול מצבי חירום ואסון', 'faculty': 'רפואה'},
 '0162': {'name': 'סיעוד', 'faculty': 'רפואה'},
 '0183': {'name': 'תכנית משותפת בפיזיותרפיה ורפוי', 'faculty': 'רפואה'},
 '0113': {'name': 'אנטומיה ואנתרפולוגיה', 'faculty': 'רפואה'},
 '0119': {'name': 'מיקרוביולוגיה ואימונולוגיה', 'faculty': 'רפואה'},
 '0165': {'name': 'ריפוי בעיסוק', 'faculty': 'רפואה'},
 '0103': {'name': 'מדעי הרפואה', 'faculty': 'רפואה'},
 '0116': {'name': 'פיזיולוגיה ופרמקולוגיה', 'faculty': 'רפואה'},
 '1882': {'name': 'פלטפורמות חיצוניות', 'faculty': 'תכניות לימוד מיוחדות'},
 '1883': {'name': 'מתחברים+', 'faculty': 'תכניות לימוד מיוחדות'},
 '1880': {'name': 'תכנית "כלים שלובים"', 'faculty': 'תכניות לימוד מיוחדות'}}


 async function downloadFile(text) {
  const fileStream = createWriteStream("lautman_courses.txt");
  const writer = fileStream.getWriter();
  var enc = new TextEncoder();

  await writer.write(enc.encode(text))

  writer.releaseLock();
  await fileStream.close();
}

const tabbize = (text) => {
  var out = ""
  for (var i = text.length-1; i >= 0; i--) {
    out += text.charAt(i) + "\t"
  }
  return out
}

const exportLatuman = () => {
  const selectedCourses = document.getElementsByClassName("courseGroup course-cell-highlight")
  const exp = {}
  for (const course of selectedCourses) {
    const number = course.getAttribute("name")
    const name = course.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.firstChild.getElementsByClassName("accordion-toggle")[0].textContent
    const depNum = number.slice(0,4)

    const type = course.textContent.slice(course.textContent.indexOf("("), course.textContent.indexOf(")")+1)

    if (!(depNum in exp)) {
      exp[depNum] = ""
    }

    const row = `${tabbize(number.slice(8,10))}${tabbize(number.slice(0,8))}9\t9\t9\t${name.slice(0, name.indexOf("(") - 1)} - ${type}\n`
    exp[depNum] += row
  }

  output = ""
  for (const [key, value] of Object.entries(exp)) {
    output += `${deps[key].name}\n${tabbize(key)}\n----------------------------\n`
    output += value + "\n\n"
  }

  downloadFile(output)
}

const printDiv = document.getElementById("goToPrint")
const button = document.createElement("button");
const buttonText = document.createTextNode("גרסה ללאוטמן")
button.appendChild(buttonText);
button.style.marginRight = "5px"
button.setAttribute("class", "btn btn-info")
button.addEventListener("click", exportLatuman)

setTimeout(() => {
    printDiv.appendChild(button);
}, 300);


