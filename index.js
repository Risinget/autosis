import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager } from '@google/generative-ai/server'
import { chromium } from 'playwright'
import fs from 'fs/promises'
import { setTimeout } from 'timers'
import Ocr from '@gutenye/ocr-node'
import 'dotenv/config'

async function ocrCaptcha(pathCaptcha) {
  const ocr = await Ocr.create()
  const result = await ocr.detect(pathCaptcha)
  const captchaText = result[0].text
  return captchaText
}

async function uploadToGemini(path, mimeType, fileManager) {
  const uploadResult = await fileManager.uploadFile(path, {
    mimeType,
    displayName: path
  })
  const file = uploadResult.file
  console.log(`Uploaded file ${file.displayName} as: ${file.name}`)
  return file
}

async function aiCaptcha(pathCaptcha, fileManager, model, config) {
  const files = [await uploadToGemini(pathCaptcha, 'image/jpeg', fileManager)]

  const chatSession = model.startChat({
    config,
    history: [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: files[0].mimeType,
              fileUri: files[0].uri
            }
          },
          { text: 'Que dice ahí?' }
        ]
      },
      {
        role: 'model',
        parts: [{ text: 'XKT7507' }]
      }
    ]
  })

  const result = await chatSession.sendMessage(
    'What does it say there? Just give me back the text without inverted commas or anything else.'
  )
  let captcha = result.response.text()
  return captcha
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJsonFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch (error) {
    console.error('Error al leer o parsear el archivo JSON:', error)
    return null
  }
}

async function tryEnterToPage(page, url, timeout = 2000, retries = 99) {
  try {
    await page.goto(url, { timeout: timeout })
    await page.waitForNavigation({ waitUntil: 'networkidle0' })
    console.log(`✅ Página cargada correctamente: ${url}`)
    return page
  } catch (error) {
    if (retries > 0) {
      console.warn(`⚠️ Fallo al cargar la página. Reintentando... (${retries} intentos restantes)`)
      return await tryEnterToPage(page, url, timeout, retries - 1)
    } else {
      console.error('Reintentos agotados. No se pudo cargar la página.')
      throw error
    }
  }
}

async function tryEnter(page, codigos, reintentos = 99) {
  await page.reload()
  let code1, code2
  try {
    code1 = await page.evaluate(() => {
      return document.querySelector(
        '#idFrmLogin > table > tbody > tr:nth-child(1) > td:nth-child(1) > span'
      ).textContent
    })

    code2 = await page.evaluate(() => {
      return document.querySelector(
        '#idFrmLogin > table > tbody > tr:nth-child(2) > td:nth-child(1) > span'
      ).textContent
    })
  } catch (error) {
    if (reintentos > 0) {
      return await tryEnter(page, codigos, reintentos - 1)
    } else {
      throw error
    }
  }

  let code_one = code1.replace(':', '')
  let code_two = code2.replace(':', '')

  console.log(code_one + ': ' + codigos[code_one])
  console.log(code_two + ': ' + codigos[code_two])

  await page.fill('input[id="idInput1"]', codigos[code_one])
  await page.fill('input[id="idInput2"]', codigos[code_two])

  await page.click('button[id="idBtnSubmit"]')
  await page.waitForNavigation({ waitUntil: 'networkidle0' })

  try {
    await page.click('button[id="idBtnAnadir"]', { timeout: 1000 })
    console.log('LO ENCONTRÓ XD')
    return page
  } catch (e) {
    let entered = await pageHasText(page, 'Retirar')
    if (entered) {
      console.log('INSCRIPCIONES ABIERTAS!')
      return page
    }
    if (reintentos > 0) {
      console.log('REINTENTANDO ENTRAR A MATERIAS AÑADIDAS: ', reintentos)
      return await tryEnter(page, codigos, reintentos - 1)
    } else {
      throw e
    }
  }
}

async function procesarMateria(materiaDocente) {
  let data = await readJsonFile('resources/data.json')
  try {
    await fs.access('captchas')
  } catch (error) {
    await fs.mkdir('captchas')
  }

  console.log('DATA', {
    CODIGOS: data.CODIGOS,
    MATERIAS: data.MATERIAS
  })
  const useAI = data.useAI
  const apiKey = data.GEMINI_API_KEY
  const genAI = new GoogleGenerativeAI(apiKey)
  const fileManager = new GoogleAIFileManager(apiKey)
  const COD_SIS = data.COD_SIS
  const PASS = data.PASS
  const DIA = data.DIA
  const MES = data.MES
  const ANIO = data.ANIO
  let codigos = {
    1: data.CODIGOS['1'],
    2: data.CODIGOS['2'],
    3: data.CODIGOS['3'],
    4: data.CODIGOS['4'],
    5: data.CODIGOS['5']
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash'
  })

  const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    responseMimeType: 'text/plain'
  }

  const randomName = Math.random().toString(36).substring(7)
  const pathCaptcha = `captchas/${randomName}.png`

  const browser = await chromium.launch({
    executablePath: 'chromium/chrome-win/chrome.exe',
    headless: false
  })

  const context = await browser.newContext({
    viewport: {
      width: 800,
      height: 700
    }
  })

  const page = await context.newPage()

  try {
    try {
      await page.goto('https://websis.umss.edu.bo/serv_estudiantes.asp', { timeout: 10000 })
      await page.goto('https://websis.umss.edu.bo/stud_codVerificacion1.asp', { timeout: 10000 })
    } catch (error) {
      browser.close()
      return await procesarMateria(materiaDocente)
    }

    await page.waitForSelector('img')
    const imageUrl = await page.evaluate(() => {
      const img = document.querySelector('img')
      return img ? img.src : null
    })

    let captchaText

    if (imageUrl) {
      let response
      try {
        response = await page.goto(imageUrl)
      } catch (error) {
        browser.close()
        return await procesarMateria(materiaDocente)
      }

      if (response.status() === 200) {
        const buffer = await response.body()
        await fs.writeFile(pathCaptcha, buffer)
        console.log('Imagen descargada exitosamente.')
      } else {
        console.log('Error al descargar la imagen:', response.status())
      }

      try {
        if (useAI) {
          captchaText = await aiCaptcha(pathCaptcha, fileManager, model, generationConfig)
        } else {
          captchaText = await ocrCaptcha(pathCaptcha)
        }
      } catch (error) {
        browser.close()
        return await procesarMateria(materiaDocente)
      }
      console.log(`✅ ${pathCaptcha}: ${captchaText}`)
    } else {
      console.log('No se encontró la imagen')
    }

    await page.goto('https://websis.umss.edu.bo/serv_estudiantes.asp')
    await page.fill('input[id="idCuenta"]', COD_SIS)
    await page.fill('input[id="idContrasena"]', PASS)
    await page.selectOption('select[id="idDia"]', { value: DIA })
    await page.selectOption('select[id="idMes"]', { value: MES })
    await page.selectOption('select[id="idAnio"]', { value: ANIO })

    await page.fill('input[id="idCodigo"]', captchaText)
    await page.click('button[id="idBtnSubmit"]')
    await page.waitForNavigation({ waitUntil: 'networkidle0' }) // fix this more later

    let errorCaptcha = await pageHasText(page, 'incorrecto')
    if (errorCaptcha) {
      browser.close()
      return await procesarMateria(materiaDocente)
    }

    let formattedCOD_SIS = COD_SIS.substring(0, 3) + '****' + COD_SIS.substring(COD_SIS.length - 2)
    let formattedDIA = '*'.repeat(DIA.length)
    let formattedMES = '*'.repeat(MES.length)
    let formattedANIO = ANIO.substring(0, 2) + '**'
    console.log('✅ Ingresado correctamente.')
    console.log('SIS: ' + formattedCOD_SIS)
    console.log('PASS: ******')
    console.log('DIA: ' + formattedDIA)
    console.log('MES: ' + formattedMES)
    console.log('ANIO: ' + formattedANIO)

    await sleep(500)
    await page.goto('https://websis.umss.edu.bo/stud_loginInscripcion.asp?codser=STUD&idcat=39')
    await sleep(500)

    const entered = await tryEnter(page, codigos)

    if (typeof entered === 'object') {
      console.log('INSCRIPCIONES ABIERTAS!')
    } else {
      console.log('INSCRIPCIONES CERRADAS')
    }

    let rowCount
    try {
      await page.waitForSelector('body > div:nth-child(8) > div.table-responsive > table tbody tr')
      rowCount = await page
        .locator('body > div:nth-child(8) > div.table-responsive > table tbody tr')
        .count()
      console.log(`Número de filas en la tabla: ${rowCount}`)
    } catch (error) {
      browser.close()
      return await procesarMateria(materiaDocente)
    }

    for (let i = 1; i <= rowCount; i++) {
      const selector = `body > div:nth-child(8) > div.table-responsive > table tbody tr:nth-child(${i}) td:nth-child(4)`

      try {
        const element = await page.waitForSelector(selector, { timeout: 100 })
        if (element) {
          let materiaText = await page.locator(selector).innerText()
          console.log(`Fila ${i}: ${materiaText}`)
          if (!materiaText.includes(materiaDocente.materia)) continue
        }
      } catch (error) {
        let filaCompleta
        try {
          filaCompleta = await page
            .locator(
              `body > div:nth-child(8) > div.table-responsive > table tbody tr:nth-child(${i}) td:nth-child(13)`
            )
            .innerText()
        } catch (error) {
          browser.close()
          return await procesarMateria(materiaDocente)
        }
        console.log(`Fila ${i}: ${filaCompleta}`)

        if (!filaCompleta.includes(materiaDocente.materia)) continue
        let buttonSelector = `body > div:nth-child(8) > div.table-responsive > table tbody tr:nth-child(${i}) td:nth-child(12) button`
        await page.click(buttonSelector)

        const result = await addGroup(page, 99, materiaDocente, browser)
        console.log('Resultado:', result ? 'Éxito' : 'Falló')
      }
    }
  } catch (e) {
    console.log(e)
  } finally {
    await browser.close()
  }
}

async function addGroup(page, retries = 99, materiaDocente, browser) {
  const select = page.locator('select[name="grupo"]')
  let docente = materiaDocente.docente
  let grupo = materiaDocente.grupo
  let regex = new RegExp(`(?=.*${docente})(?=.*${grupo})`, 'i')

  const optionLocator = page.locator('select[name="grupo"] option').filter({
    hasText: regex
  })

  if ((await optionLocator.count()) === 0) {
    console.log('La opción no se encontró.')

    const loggedOut = await pageHasText(page, 'Servicio a Estudiantes')
    if (loggedOut) {
      browser.close()
      return await procesarMateria(materiaDocente)
    }
    if (retries > 0) {
      console.log(`Reintentando (${retries} intentos restantes): Buscando... ${docente} - ${grupo}`)
      await page.reload()
      await sleep(5000)
      return await addGroup(page, retries - 1, materiaDocente, browser)
    } else {
      console.log('Reintentos agotados.')
      return false
    }
  }

  const value = await optionLocator.first().getAttribute('value')
  console.log('VALUE: ', value)

  await select.selectOption({ value })
  await page.click('button[id="idBtnAnadir"]')

  let hasError = await pageHasText(page, 'error occurred')
  let isFull = await pageHasText(page, 'lleno')
  let successfullyAdded = await pageHasText(page, 'Retirar')

  if (hasError) {
    console.log(hasError, 'Error occurred')
    return await addGroup(page, retries - 1, materiaDocente, browser)
  } else if (isFull) {
    console.log(isFull, 'Grupo lleno')
    const page2 = await page.goBack()
    return await addGroup(page2, retries - 1, materiaDocente, browser)
  } else if (successfullyAdded) {
    console.log('Grupo añadido correctamente')
    return true
  }
}

async function pageHasText(page, text) {
  return (await page.locator('body').innerText()).includes(text)
}

async function main() {
  let data = await readJsonFile('resources/data.json')
  const materiaDocentes = data.MATERIAS

  try {
    await Promise.all(materiaDocentes.map((materiaDocente) => procesarMateria(materiaDocente)))
  } catch (error) {
    console.log(error)
  }
}

async function run() {
  try {
    await main() 
  } catch (error) {
   
    const errorMessage = `[${new Date().toISOString()}] Error: ${error.message}\nStack Trace: ${error.stack}\n\n`
    await fs.appendFile('logs.txt', errorMessage)
    console.error('Ocurrió un error. Ver logs.txt para más detalles.')
  }
}


run()