import 'dotenv/config'; // Загружаем переменные из .env для локального тестирования
import { Telegraf } from 'telegraf';
import crypto from 'crypto';
import fs from 'fs/promises';
import cron from 'node-cron';


const DB_FILE = 'users.json'; // Имя файла нашей "базы данных"
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

const bot = new Telegraf(BOT_TOKEN);

// Читаем список пользователей из файла
async function getUsers() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // Если файла еще нет (при первом запуске), возвращаем пустой массив
    return [];
  }
}

// Записываем обновленный список пользователей в файл
async function saveUsers(users) {
  await fs.writeFile(DB_FILE, JSON.stringify(users, null, 2));
}

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

// 2. ЗАПРОС КОНКУРЕНТОВ (БЕРЕМ ТОП-2 ДЕШЕВЫХ МАШИНЫ)
async function getMarketPricesForModel(brandRaw, modelRaw, genRaw) {
  if (!brandRaw || !modelRaw) return null;

  // 🔥 Меняем size=1 на size=2
  let url = `https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=2010&cur=BYR&sort=prc.a&size=2&cbnd2=${brandRaw}&cmdl2=${modelRaw}`;
  if (genRaw) url += `&cgen2=${genRaw}`;

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
      // Превращаем массив объектов в простой массив цен: [1500, 2000]
      return data.ads
        .map(ad => ad.price_usd ? parseInt(ad.price_usd, 10) / 100 : 0)
        .filter(price => price > 0);
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
      const marketPrices = await getMarketPricesForModel(car.brandRaw, car.modelRaw, car.genRaw);
      if (!marketPrices || marketPrices.length === 0) return null;

      const firstPrice = marketPrices[0];
      const secondPrice = marketPrices.length > 1 ? marketPrices[1] : null;

      // 🔥 НОВЫЙ ФИЛЬТР: Отбраковываем штучные экземпляры
      if (!secondPrice) {
        console.log(`🦄 Отбраковано (Эксклюзив/Нет конкурентов): ${car.title} за ${car.price}$`);
        return null;
      }

      // Оцениваем только если наша машина — первая по цене (или дешевле первой из-за кэша)
      if (car.price <= firstPrice) {

        // Считаем разницу именно со ВТОРОЙ машиной
        const diffFromSecond = ((secondPrice - car.price) / secondPrice) * 100;

        // 🔥 АНТИ-ХЛАМ: Разница больше 30% — это битье или фейк
        if (diffFromSecond >= 30) {
          console.log(`🗑 Отбраковано (Битье/Фейк): ${car.title} за ${car.price}$ (Вторая цена: ${secondPrice}$)`);
          return null;
        }

        return {
          ...car,
          marketPrice: secondPrice,
          discountPct: Math.round(diffFromSecond)
        };
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
      message += `💰 Цена: **${deal.price}$** (Дешевле конкурента на ${deal.discountPct}%!)\n`;
      message += `📊 Ближайшая цена на сайте: ~${deal.marketPrice}$\n`;
      message += `🔗 [Смотреть объявление](${deal.url})\n\n`;
    });

    // Если команду вызвали вручную (/check)
    if (ctx) {
      await ctx.replyWithMarkdown(message, { disable_web_page_preview: true });
    }
    // Если это фоновый запуск по крону (Рассылка всем)
    else {
      const users = await getUsers();
      if (users.length === 0) {
        console.log('🤷‍♂️ Рассылка отменена: в базе нет ни одного подписчика.');
        return;
      }

      console.log(`📨 Начинаем рассылку для ${users.length} пользователей...`);

      // ТЕПЕРЬ МЫ ПЕРЕБИРАЕМ ОБЪЕКТЫ USERS
      for (const user of users) {
        const chatId = user.id; // Достаем ID из объекта

        // В будущем здесь можно будет делать проверку:
        // if (user.region && car.region !== user.region) continue;

        try {
          await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
        } catch (error) {
          console.error(`❌ Ошибка отправки пользователю ${chatId}:`, error.description);

          if (error.description && error.description.includes('bot was blocked by the user')) {
            console.log(`🗑 Удаляем пользователя ${chatId} из базы (он заблокировал бота).`);
            // Удаляем по ID
            const updatedUsers = await getUsers();
            const filteredUsers = updatedUsers.filter(u => u.id !== chatId);
            await saveUsers(filteredUsers);
          }
        }
      }
      console.log('✅ Рассылка завершена.');
    }
  } else {
    if (ctx) ctx.reply('🤷‍♂️ Свежих машин по низу рынка сейчас нет.');
    console.log('✅ Анализ завершен. Низ рынка не найден.');
  }
}

// --- УПРАВЛЕНИЕ БОТОМ ---
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  let users = await getUsers();

  // Проверяем, есть ли уже этот пользователь в базе (ищем объект с таким id)
  const existingUser = users.find(u => u.id === chatId);

  if (!existingUser) {
    // Добавляем ПОЛНОЦЕННЫЙ ОБЪЕКТ
    users.push({
      id: chatId,
      region: null, // Пока регион не задан
      price: 20     // Дефолтная цена для юзера
    });

    await saveUsers(users);
    ctx.reply('👋 Привет! Ты успешно подписался на ежечасную рассылку выгодных авто.\n\nКоманды:\n/check — проверить рынок прямо сейчас\n/stop — отписаться от рассылки');
    console.log(`🎉 Новый подписчик: ${chatId}. Всего: ${users.length}`);
  } else {
    ctx.reply('✅ Ты уже подписан на рассылку!');
  }
});

bot.command('stop', async (ctx) => {
  const chatId = ctx.chat.id;
  let users = await getUsers();

  const existingUser = users.find(u => u.id === chatId);

  if (existingUser) {
    // Оставляем в массиве всех, кроме текущего пользователя
    users = users.filter(u => u.id !== chatId);
    await saveUsers(users);
    ctx.reply('❌ Ты отписался от рассылки. Жаль, что уходишь!\n\nЕсли захочешь вернуться, просто нажми /start');
    console.log(`📉 Пользователь ${chatId} отписался. Осталось: ${users.length}`);
  } else {
    ctx.reply('🤷‍♂️ Ты и так не был подписан.');
  }
});

bot.command('check', async (ctx) => {
  await ctx.reply('⏳ Сканирую свежие объявления и сравниваю с низом рынка...');
  await processAndSendDeals(ctx); // Передаем ctx, чтобы бот ответил лично
});

// Секретная команда для админа
bot.command('users', async (ctx) => {
  if (`${ctx.chat.id}` !== `${ADMIN_ID}`) {
    return; // Если пишет кто-то другой, бот просто промолчит
  }

  try {
    const users = await getUsers();

    // Формируем красивое сообщение
    let text = `📊 **Статистика базы данных:**\n`;
    text += `Всего подписчиков: ${users.length}\n\n`;

    // Отправляем текст
    await ctx.replyWithMarkdown(text);

    // Отправляем сам файл users.json прямо в чат!
    await ctx.replyWithDocument({ source: DB_FILE });

  } catch (error) {
    ctx.reply('❌ Ошибка при чтении файла пользователей.');
  }
});

bot.launch().then(() => {
  console.log('🤖 Бот успешно запущен на сервере!');

  // 1. Делаем немедленный первый запуск при старте сервера (чтобы не ждать целый час)
  console.log('⚡ Выполняю стартовую проверку рынка...');
  processAndSendDeals();

  // 2. Инициализируем и запускаем ежечасный таймер
  activeCronTask = cron.schedule('*/15 * * * *', () => {
    console.log('⏰ [Тест] Сработал 15-минутный таймер!');
    processAndSendDeals();
  });

  console.log('⏰ Автоматический таймер на каждый час успешно активирован.');
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
//     deals = await analyzeMarket(cars);

//     console.log(`🔥 Найдено выгодных предложений: ${deals.length}`);
//     if (deals.length > 0) {
//       console.log(deals);
//     }
//   } else {
//     console.log('❌ Данные не собраны. Проверь селекторы!');
//   }
// }
// runLocalDebug();