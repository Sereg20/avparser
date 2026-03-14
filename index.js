import { Telegraf } from 'telegraf';
import { chromium } from 'playwright';
import 'dotenv/config';

// --- НАСТРОЙКИ ---
const TARGET_URL = process.env.TARGET_URL;
const DISCOUNT_THRESHOLD = process.env.DISCOUNT_THRESHOLD;

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- ЛОГИКА ПАРСИНГА ---
async function fetchCarsData() {
    console.log('Запуск Playwright...');
    
    // Включаем видимый режим и добавляем паузу в 500мс между действиями
    const browser = await chromium.launch({ 
        headless: false, 
        slowMo: 500 
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();
    let results = [];

    try {
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await new Promise(res => setTimeout(res, 10000))
        
        // Ждем появления списка объявлений (ЗАМЕНИ СЕЛЕКТОР НА РЕАЛЬНЫЙ С AV.BY)
        const elem = await page.waitForSelector('.listing-item', { timeout: 10000 });
        // Собираем данные внутри контекста браузера
        await new Promise(res => setTimeout(res, 10000))
        results = await page.$$eval('.listing-item', (listings) => {
            return listings.map(item => {
                // ВНИМАНИЕ: Замени эти селекторы на те, что используются на сайте
                const titleEl = item.querySelector('.link-text');
                const priceEl = item.querySelector('.listing-item__price-primary');
                const yearEl = item.querySelector('.listing-item__params');
                const mileageEl = item.querySelector('.listing-item__params div:nth-child(3) span');
                const linkEl = item.querySelector('a');

                if (!titleEl || !priceEl || !yearEl || !mileageEl || !linkEl) return null;

                // Очистка данных (убираем пробелы, 'км', '$' и переводим в числа)
                const priceStr = priceEl.innerText.replace(/\D/g, ''); 
                const mileageStr = mileageEl.innerText.replace(/\D/g, '');

                return {
                    title: titleEl.innerText.trim(),
                    price: parseInt(priceStr, 10),
                    year: parseInt(yearEl.innerText, 10),
                    mileage: parseInt(mileageStr, 10),
                    url: linkEl.href
                };
            }).filter(item => item !== null); // Убираем пустые записи
        });

    } catch (error) {
        console.error('Ошибка при парсинге:', error);
    } finally {
        await browser.close();
    }

    return results;
}

// --- ЛОГИКА АНАЛИЗА ---
function analyzeMarket(cars) {
    const marketGroups = {};

    // 1. Группируем машины по "Название + Год"
    cars.forEach(car => {
        const key = `${car.title}_${car.year}`;
        if (!marketGroups[key]) marketGroups[key] = [];
        marketGroups[key].push(car.price);
    });

    const medianPrices = {};

    // 2. Считаем медианную цену (или среднюю) для каждой группы
    for (const [key, prices] of Object.entries(marketGroups)) {
        if (prices.length >= 3) { // Считаем рынок, если есть хотя бы 3 похожих авто
            prices.sort((a, b) => a - b);
            const mid = Math.floor(prices.length / 2);
            medianPrices[key] = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
        }
    }

    const profitableDeals = [];

    // 3. Ищем машины, которые дешевле медианы
    cars.forEach(car => {
        const key = `${car.title}_${car.year}`;
        if (medianPrices[key]) {
            const marketPrice = medianPrices[key];
            const discount = ((marketPrice - car.price) / marketPrice) * 100;

            if (discount >= DISCOUNT_THRESHOLD) {
                profitableDeals.push({
                    ...car,
                    marketPrice: marketPrice,
                    discountPct: Math.round(discount)
                });
            }
        }
    });

    return profitableDeals;
}

// --- ОБРАБОТЧИК ТЕЛЕГРАМ БОТА ---
bot.command('search', async (ctx) => {
    await ctx.reply('🔍 Запускаю сбор данных с сайта и анализ рынка. Подождите немного...');

    const carsData = await fetchCarsData();

    if (carsData.length === 0) {
        return ctx.reply('❌ Не удалось собрать данные. Возможно, изменилась верстка сайта или сработала защита.');
    }

    await ctx.reply(`📊 Собрано объявлений: ${carsData.length}. Идет анализ цен...`);

    const bestDeals = analyzeMarket(carsData);

    if (bestDeals.length > 0) {
        let message = `🔥 **Найдены машины ниже рынка (скидка от ${DISCOUNT_THRESHOLD}%):**\n\n`;
        
        bestDeals.forEach(deal => {
            message += `🚗 **${deal.title}** (${deal.year} г., ${deal.mileage} км)\n`;
            message += `💰 Цена: ${deal.price}$ (Рынок: ~${deal.marketPrice}$)\n`;
            message += `📉 Выгода: ${deal.discountPct}%\n`;
            message += `🔗 [Смотреть объявление](${deal.url})\n\n`;
        });

        await ctx.replyWithMarkdown(message);
    } else {
        await ctx.reply('😔 На данный момент откровенно заниженных цен по заданным параметрам нет.');
    }
});

// Запуск бота
bot.launch().then(() => console.log('Бот успешно запущен!'));

// Остановка при завершении процесса
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- БЛОК ЛОКАЛЬНОЙ ОТЛАДКИ ---
async function runLocalDebug() {
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
        const deals = analyzeMarket(cars);
        
        console.log(`🔥 Найдено выгодных предложений: ${deals.length}`);
        if (deals.length > 0) {
            console.log(deals);
        }
    } else {
        console.log('❌ Данные не собраны. Проверь селекторы!');
    }
}

// Раскомментируй строку ниже, чтобы запустить скрипт локально в консоли
runLocalDebug();