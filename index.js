import { Telegraf } from 'telegraf';
import 'dotenv/config';
import crypto from 'crypto'; // Добавляем встроенный генератор случайных ID

// --- НАСТРОЙКИ ---
const DISCOUNT_THRESHOLD = process.env.DISCOUNT_THRESHOLD;

const bot = new Telegraf(process.env.BOT_TOKEN);

// Вспомогательная функция для извлечения данных из массива ad_parameters
function getAdParam(parameters, paramName, key = 'vl') {
  const param = parameters.find(p => p.p === paramName);
  return param ? param[key] : null;
}

async function fetchCarsData() {
  console.log('🌐 Запрашиваем свежие объявления с API Куфара...');
  let results = [];

  // Я добавил в URL параметры size=30 (максимум на страницу) и lang=ru из твоего curl
  const url = 'https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=2010&cur=BYR&sort=lst.d&size=30&lang=ru';

  // Формируем заголовки, маскируясь под реальный браузер
  const headers = {
    'accept': '*/*',
    'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'origin': 'https://auto.kufar.by',
    'pragma': 'no-cache',
    'referer': 'https://auto.kufar.by/',
    'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    // Генерируем уникальный ID для каждого запроса, чтобы не "светить" одним и тем же
    'x-searchid': crypto.randomUUID(),
    // Важнейший внутренний заголовок Куфара для правильного роутинга
    'x-segmentation': 'routing=web_auto;platform=web;application=ad_view;taxonomy-version=2'
  };

  try {
    // Передаем заголовки вторым аргументом в функцию fetch
    const response = await fetch(url, { method: 'GET', headers: headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ошибка API: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.ads || data.ads.length === 0) return results;

    for (const ad of data.ads) {
      // Базовые параметры
      const brand = getAdParam(ad.ad_parameters, 'cars_brand_v2') || 'Неизвестная марка';
      const model = getAdParam(ad.ad_parameters, 'cars_model_v2') || '';
      const yearStr = getAdParam(ad.ad_parameters, 'regdate', 'v');
      const mileageStr = getAdParam(ad.ad_parameters, 'mileage', 'v');
      const priceUsd = ad.price_usd ? parseInt(ad.price_usd, 10) / 100 : 0;

      // 🔥 НОВЫЕ ПАРАМЕТРЫ 🔥
      const engine = getAdParam(ad.ad_parameters, 'cars_engine') || 'Не указан';
      const capacity = getAdParam(ad.ad_parameters, 'cars_capacity') || '';
      const gearbox = getAdParam(ad.ad_parameters, 'cars_gearbox') || 'Не указана';

      if (brand && yearStr && priceUsd > 0) {
        results.push({
          title: `${brand} ${model}`.trim(),
          price: priceUsd,
          year: parseInt(yearStr, 10),
          mileage: mileageStr ? parseInt(mileageStr, 10) : 0,
          // Добавляем новые поля в итоговый объект
          engine: engine,
          capacity: capacity,
          gearbox: gearbox,
          url: ad.ad_link
        });
      }
    }
  } catch (error) {
    console.error('❌ Ошибка при запросе:', error);
  }

  return results;
}

async function runScheduledJob() {
  console.log(`\n⏳ [${new Date().toLocaleTimeString()}] Запуск проверки по расписанию...`);

  if (CHAT_ID === 'ТВОЙ_CHAT_ID') {
    console.log('⚠️ ВНИМАНИЕ: CHAT_ID не установлен. Отправка в Телеграм невозможна.');
    return;
  }

  const carsData = await fetchCarsData();
  console.log(`✅ Собрано объявлений с первой страницы: ${carsData.length}`);

  if (carsData.length === 0) return;

  const bestDeals = analyzeMarket(carsData);

  if (bestDeals.length > 0) {
    let message = `🔥 **Ежечасный скаут: Найдены выгодные авто!**\n\n`;

    bestDeals.forEach(deal => {
      message += `🚗 **${deal.title}** (${deal.year} г., ${deal.mileage} км)\n`;
      message += `💰 Цена: ${deal.price}$ (Рынок: ~${deal.marketPrice}$)\n`;
      message += `📉 Выгода: ${deal.discountPct}%\n`;
      message += `🔗 [Смотреть объявление](${deal.url})\n\n`;
    });

    // Отправляем сообщение конкретному пользователю
    try {
      await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
      console.log('📨 Уведомление успешно отправлено в Телеграм!');
    } catch (error) {
      console.error('❌ Ошибка отправки в Телеграм:', error.description);
    }
  } else {
    console.log('🤷‍♂️ За этот час выгодных предложений не появилось.');
  }
}

// --- ЛОГИКА АНАЛИЗА ---
function analyzeMarket(cars) {

}

// --- КОМАНДЫ БОТА ---
// Команда для получения своего CHAT_ID
bot.start((ctx) => {
  ctx.reply(`Привет! Твой CHAT_ID: ${ctx.chat.id}\n\nСкопируй эти цифры (включая минус, если он есть) и вставь их в переменную CHAT_ID в коде index.js.`);
});

bot.command('status', (ctx) => {
  ctx.reply('🟢 Сервис мониторинга работает в фоновом режиме.');
});

// --- ЗАПУСК ---
bot.launch().then(() => {
  console.log('🤖 Телеграм-бот запущен!');

  // Запускаем парсер первый раз сразу при старте скрипта
  runScheduledJob();

  // Настраиваем интервал запуска: 1 час = 60 минут * 60 секунд * 1000 миллисекунд
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(runScheduledJob, ONE_HOUR);
  console.log('⏰ Таймер установлен на 1 час.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- БЛОК ЛОКАЛЬНОЙ ОТЛАДКИ ---

// async function runLocalDebug() {
//   let deals = [];
//   console.log('🛠 --- СТАРТ ЛОКАЛЬНОЙ ОТЛАДКИ --- 🛠');

//   // 1. Запускаем только сбор данных
//   const cars = await fetchCarsData();

//   console.log(`\n✅ Собрано объявлений: ${cars.length}`);

//   // Выводим первые 3 машины в консоль, чтобы проверить, правильно ли спарсились данные
//   if (cars.length > 0) {
//     console.log('👀 Пример собранных данных (первые 3):');
//     console.log(cars.slice(0, 3));

//     // 2. Тестируем математику анализа
//     console.log('\n🧠 --- ЗАПУСК АНАЛИЗА --- 🧠');
//     // deals = analyzeMarket(cars);

//     console.log(`🔥 Найдено выгодных предложений: ${deals.length}`);
//     if (deals.length > 0) {
//       console.log(deals);
//     }
//   } else {
//     console.log('❌ Данные не собраны. Проверь селекторы!');
//   }
// }
// runLocalDebug();