import 'dotenv/config'; // Загружаем переменные из .env для локального тестирования
import { Telegraf } from 'telegraf';
import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const bot = new Telegraf(BOT_TOKEN);

// Вспомогательная функция (по умолчанию тянет красивый 'vl', но можно попросить сырой 'v')
function getAdParam(parameters, paramName, key = 'vl') {
  const param = parameters.find(p => p.p === paramName);
  return param ? param[key] : null;
}

// 1. ПОИСК СВЕЖИХ ОБЪЯВЛЕНИЙ
async function fetchCarsData() {
  console.log(`\n[${new Date().toLocaleTimeString('ru-RU')}] 🌐 Запрашиваем свежие объявления (1 страница)...`);
  let results = [];

  const url = 'https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=2010&cur=BYR&sort=lst.d&size=30&lang=ru';
  const headers = {
    'accept': '*/*',
    'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'x-searchid': crypto.randomUUID(),
    'x-segmentation': 'routing=web_auto;platform=web;application=ad_view;taxonomy-version=2'
  };

  try {
    const response = await fetch(url, { headers });
    console.log(response)
    if (!response.ok) throw new Error(`Ошибка API: ${response.status}`);

    const data = await response.json();
    if (!data.ads || data.ads.length === 0) return results;

    for (const ad of data.ads) {
      // КРАСИВЫЕ ДАННЫЕ ДЛЯ ТЕЛЕГРАМА (vl)
      const brandLabel = getAdParam(ad.ad_parameters, 'cars_brand_v2', 'vl') || 'Неизвестная марка';
      const modelLabel = getAdParam(ad.ad_parameters, 'cars_model_v2', 'vl') || '';
      const genLabel = getAdParam(ad.ad_parameters, 'cars_gen_v2', 'vl') || '';
      const engineLabel = getAdParam(ad.ad_parameters, 'cars_engine', 'vl') || 'Не указан';
      const capacityLabel = getAdParam(ad.ad_parameters, 'cars_capacity', 'vl') || '';
      const gearboxLabel = getAdParam(ad.ad_parameters, 'cars_gearbox', 'vl') || 'Не указана';

      // ДАННЫЕ В ЛЮБОМ СЛУЧАЕ ЛЕЖАТ В 'v'
      const yearStr = getAdParam(ad.ad_parameters, 'regdate', 'v');
      const mileageStr = getAdParam(ad.ad_parameters, 'mileage', 'v');
      const priceUsd = ad.price_usd ? parseInt(ad.price_usd, 10) / 100 : 0;

      // СЫРЫЕ СИСТЕМНЫЕ ДАННЫЕ ДЛЯ ВТОРОГО ЗАПРОСА (v)
      const brandRaw = getAdParam(ad.ad_parameters, 'cars_brand_v2', 'v');
      const modelRaw = getAdParam(ad.ad_parameters, 'cars_model_v2', 'v');
      const genRaw = getAdParam(ad.ad_parameters, 'cars_gen_v2', 'v');

      if (brandRaw && yearStr && priceUsd > 0) {
        results.push({
          title: `${brandLabel} ${modelLabel} ${genLabel}`.trim(),
          price: priceUsd,
          year: parseInt(yearStr, 10),
          mileage: mileageStr ? parseInt(mileageStr, 10) : 0,
          techInfo: `${capacityLabel} ${engineLabel}, ${gearboxLabel}`,
          url: ad.ad_link,
          brandRaw, modelRaw, genRaw // Сохраняем системные ключи для анализа
        });
      }
    }
  } catch (error) {
    console.error('❌ Ошибка при первичном парсинге:', error);
  }
  return results;
}

// 2. ЗАПРОС КОНКУРЕНТОВ (САМОЙ ДЕШЕВОЙ МАШИНЫ ЭТОЙ ЖЕ МОДЕЛИ И ПОКОЛЕНИЯ)
async function getCheapestPriceForModel(brandRaw, modelRaw, genRaw) {
  if (!brandRaw || !modelRaw) return null;

  let url = `https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=2010&cur=BYR&sort=prc.a&size=1&cbnd2=${brandRaw}&cmdl2=${modelRaw}`;
  if (genRaw) url += `&cgen2=${genRaw}`; // Строгое соответствие поколению!

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'x-searchid': crypto.randomUUID()
      }
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (data.ads && data.ads.length > 0) {
      return data.ads[0].price_usd ? parseInt(data.ads[0].price_usd, 10) / 100 : null;
    }
  } catch (error) {
    console.error(`Ошибка поиска рынка:`, error.message);
  }
  return null;
}

// 3. АНАЛИЗ (ПАКЕТЫ ПО 10 ЗАПРОСОВ)
async function analyzeMarket(cars) {
  console.log(`🧠 Анализируем ${cars.length} авто на "низ рынка"...`);
  const profitableDeals = [];
  const chunkSize = 10;

  for (let i = 0; i < cars.length; i += chunkSize) {
    const chunk = cars.slice(i, i + chunkSize);
    const promises = chunk.map(async (car) => {
      const cheapestMarketPrice = await getCheapestPriceForModel(car.brandRaw, car.modelRaw, car.genRaw);
      if (!cheapestMarketPrice) return null;

      // Если наша свежая машина стоит столько же, сколько самая дешевая на сайте, ИЛИ дешевле
      if (car.price <= cheapestMarketPrice) {
        let discountPct = 0;
        if (car.price < cheapestMarketPrice) {
          discountPct = Math.round(((cheapestMarketPrice - car.price) / cheapestMarketPrice) * 100);
        }

        return { ...car, marketPrice: cheapestMarketPrice, discountPct };
      }
      return null;
    });

    const results = await Promise.allSettled(promises);

    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value !== null) {
        profitableDeals.push(result.value);
      }
    });

    if (i + chunkSize < cars.length) {
      await new Promise(resolve => setTimeout(resolve, 1500)); // Пауза анти-бан
    }
  }
  return profitableDeals;
}

// 4. ГЛАВНАЯ ФУНКЦИЯ (СБОР -> АНАЛИЗ -> ТЕЛЕГРАМ)
async function processAndSendDeals(ctx = null) {
  const carsData = await fetchCarsData();
  if (carsData.length === 0) return;

  const bestDeals = await analyzeMarket(carsData);

  if (bestDeals.length > 0) {
    let message = `🔥 **ТОП рынка: Найдены самые дешевые авто!**\n\n`;
    bestDeals.forEach(deal => {
      message += `🚗 **${deal.title}** (${deal.year} г., ${deal.mileage} км)\n`;
      message += `⚙️ Техника: ${deal.techInfo}\n`;

      if (deal.discountPct > 0) {
        message += `💰 Цена: **${deal.price}$** (Дешевле самого низа на ${deal.discountPct}%!)\n`;
      } else {
        message += `💰 Цена: **${deal.price}$** (Это первая цена по Беларуси)\n`;
      }

      message += `🔗 [Смотреть объявление](${deal.url})\n\n`;
    });

    try {
      if (ctx) await ctx.replyWithMarkdown(message, { disable_web_page_preview: true });
      else if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      console.log(`✅ Отправлено выгодных предложений: ${bestDeals.length}`);
    } catch (error) {
      console.error('❌ Ошибка Telegram:', error.description);
    }
  } else {
    if (ctx) ctx.reply('🤷‍♂️ Свежих машин по низу рынка сейчас нет.');
    console.log('✅ Анализ завершен. Низ рынка не найден.');
  }
}

// --- УПРАВЛЕНИЕ БОТОМ ---
bot.start((ctx) => ctx.reply(`Твой ID: \`${ctx.chat.id}\``));
bot.command('check', async (ctx) => {
  await ctx.reply('⏳ Сканирую свежие объявления и сравниваю с низом рынка...');
  await processAndSendDeals(ctx);
});

bot.launch().then(() => {
  console.log('🤖 Бот успешно запущен (Локальный режим с .env)');
  // Для запуска по крону раскомментируй импорт node-cron и блок ниже:
  // cron.schedule('0 * * * *', processAndSendDeals);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- БЛОК ЛОКАЛЬНОЙ ОТЛАДКИ ---

async function runLocalDebug() {
  let deals = [];
  console.log('🛠 --- СТАРТ ЛОКАЛЬНОЙ ОТЛАДКИ --- 🛠');

  // 1. Запускаем только сбор данных
  const cars = await fetchCarsData();

  console.log(`\n✅ Собрано объявлений: ${cars.length}`);

  // Выводим первые 3 машины в консоль, чтобы проверить, правильно ли спарсились данные
  if (cars.length > 0) {
    console.log('👀 Пример собранных данных (первые 3):');
    console.log(cars.slice(0, 3));

    // 2. Тестируем математику анализа
    console.log('\n🧠 --- ЗАПУСК АНАЛИЗА --- 🧠');
    deals = await analyzeMarket(cars);

    console.log(`🔥 Найдено выгодных предложений: ${deals.length}`);
    if (deals.length > 0) {
      console.log(deals);
    }
  } else {
    console.log('❌ Данные не собраны. Проверь селекторы!');
  }
}
runLocalDebug();