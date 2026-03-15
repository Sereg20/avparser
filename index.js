import { Telegraf } from 'telegraf';
import crypto from 'crypto';
import cron from 'node-cron';

// Берем данные из переменных окружения сервера
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DISCOUNT_THRESHOLD = 15;

const bot = new Telegraf(BOT_TOKEN);

function getAdParam(parameters, paramName, key = 'vl') {
  const param = parameters.find(p => p.p === paramName);
  return param ? param[key] : null;
}

async function fetchCarsData() {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] 🌐 Запрашиваем API Куфара...`);
  let results = [];

  const url = 'https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=2010&cur=BYR&sort=lst.d&size=30&lang=ru';
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
    'x-searchid': crypto.randomUUID(),
    'x-segmentation': 'routing=web_auto;platform=web;application=ad_view;taxonomy-version=2'
  };

  try {
    const response = await fetch(url, { method: 'GET', headers: headers });
    if (!response.ok) throw new Error(`Ошибка API: ${response.status}`);

    const data = await response.json();
    if (!data.ads || data.ads.length === 0) return results;

    for (const ad of data.ads) {
      const brand = getAdParam(ad.ad_parameters, 'cars_brand_v2') || 'Неизвестная марка';
      const model = getAdParam(ad.ad_parameters, 'cars_model_v2') || '';
      const yearStr = getAdParam(ad.ad_parameters, 'regdate', 'v');
      const mileageStr = getAdParam(ad.ad_parameters, 'mileage', 'v');
      const engine = getAdParam(ad.ad_parameters, 'cars_engine') || 'Не указан';
      const capacity = getAdParam(ad.ad_parameters, 'cars_capacity') || '';
      const gearbox = getAdParam(ad.ad_parameters, 'cars_gearbox') || 'Не указана';
      const priceUsd = ad.price_usd ? parseInt(ad.price_usd, 10) / 100 : 0;

      if (brand && yearStr && priceUsd > 0) {
        results.push({
          title: `${brand} ${model}`.trim(),
          price: priceUsd,
          year: parseInt(yearStr, 10),
          mileage: mileageStr ? parseInt(mileageStr, 10) : 0,
          engine, capacity, gearbox,
          url: ad.ad_link
        });
      }
    }
  } catch (error) {
    console.error('❌ Ошибка при запросе:', error);
  }
  return results;
}

function analyzeMarket(cars) {
  
  return cars[0];
}

// Выносим логику отправки в отдельную функцию, чтобы вызывать ее и по крону, и вручную
async function processAndSendDeals(ctx = null) {
  const carsData = await fetchCarsData();

  if (carsData.length === 0) {
    if (ctx) ctx.reply('❌ Не удалось получить данные с Куфара.');
    return;
  }

  const bestDeals = analyzeMarket(carsData);

  if (bestDeals.length > 0) {
    let message = `🔥 **Найдены выгодные авто (Скидка от ${DISCOUNT_THRESHOLD}%):**\n\n`;
    bestDeals.forEach(deal => {
      message += `🚗 **${deal.title}** (${deal.year} г., ${deal.mileage} км)\n`;
      message += `⚙️ Техника: ${deal.capacity} ${deal.engine}, ${deal.gearbox}\n`;
      message += `💰 Цена: ${deal.price}$ (Рынок: ~${deal.marketPrice}$)\n`;
      message += `📉 Выгода: ${deal.discountPct}%\n`;
      message += `🔗 [Смотреть объявление](${deal.url})\n\n`;
    });

    try {
      if (ctx) {
        await ctx.replyWithMarkdown(message); // Ответ на ручную команду
      } else if (CHAT_ID) {
        await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' }); // Автоматическая рассылка
      }
    } catch (error) {
      console.error('Ошибка Телеграм:', error.description);
    }
  } else {
    if (ctx) ctx.reply('🤷‍♂️ Сейчас нет выгодных предложений.');
    console.log('Выгодных предложений не найдено.');
  }
}

// --- КОМАНДЫ БОТА ---
bot.start((ctx) => {
  ctx.reply(`Привет! Твой CHAT_ID: \`${ctx.chat.id}\`\nДобавь его в переменные окружения на сервере.`);
});

bot.command('check', async (ctx) => {
  await ctx.reply('⏳ Запускаю внеочередную проверку рынка...');
  await processAndSendDeals(ctx);
});

// --- ЗАПУСК БОТА И КРОНА ---
bot.launch().then(() => {
  console.log('🤖 Бот запущен! Ожидаю расписания...');

  // Запуск крона (0 * * * * означает "в 00 минут каждого часа", например 14:00, 15:00)
  cron.schedule('0 * * * *', () => {
    console.log('⏰ Сработал таймер расписания!');
    processAndSendDeals();
  });
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