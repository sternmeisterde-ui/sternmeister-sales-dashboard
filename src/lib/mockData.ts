export interface ManagerCall {
    id: string;
    name: string;
    avatarUrl: string;
    callDuration: string;
    callNumber?: string;
    score: number;
    audioUrl: string;
    kommoUrl: string;
    date: string;
    transcript: string;
    aiFeedback: string;
    summary: string;
    hasRecording: boolean;
    blocks: {
        id: string;
        name: string;
        score: number;
        maxScore: number;
        feedback: string;
        criteria: { id: number; name: string; score: number; maxScore: number; feedback: string; quote: string }[];
    }[];
    clientScoring?: { urgency: number; solvency: number; need: number; total: number };
}

export interface ManagerStat {
    id: string;
    name: string;
    avatarUrl: string;
    totalCalls: number;
    avgScore: number;
    avgDuration: string;
    conversionRate: string;
    role?: string;
    line?: string | null; // '1' (квалификатор) | '2' (бератер)
}

// 📌 ЗАГЛУШКИ ДЛЯ ГРАФИКОВ
export const salesTrendData = [
    { name: 'Mon', revenue: 4200, b2gCalls: 120, b2bCalls: 300 },
    { name: 'Tue', revenue: 3800, b2gCalls: 110, b2bCalls: 280 },
    { name: 'Wed', revenue: 5100, b2gCalls: 140, b2bCalls: 350 },
    { name: 'Thu', revenue: 4700, b2gCalls: 130, b2bCalls: 320 },
    { name: 'Fri', revenue: 5900, b2gCalls: 160, b2bCalls: 400 },
    { name: 'Sat', revenue: 2390, b2gCalls: 40, b2bCalls: 120 },
    { name: 'Sun', revenue: 1490, b2gCalls: 20, b2bCalls: 80 },
];

// 📌 ЗАГЛУШКИ: Сводные метрики бизнеса ("Дашборд")
export const businessMetrics = {
    revenue: { value: "$2.4M", dailyGrowth: "+12%", weeklyGrowth: "+5.4%" },
    bestManager: { name: "Ivan K.", value: "$450k", dailyGrowth: "+8%", weeklyGrowth: "+14%" },
    avgCallDuration: { value: "05:30", dailyGrowth: "-2%", weeklyGrowth: "+1%" },
    callsB2G: { value: "840", dailyGrowth: "+5%", weeklyGrowth: "+10%" },
    callsB2B: { value: "2150", dailyGrowth: "+15%", weeklyGrowth: "+22%" },
};

// 📌 ЗАГЛУШКИ: Аналитика по менеджерам (Верхняя панель)
export const mockManagers: ManagerStat[] = [
    { id: "uuid-1", name: "Alex T.", avatarUrl: "https://i.pravatar.cc/150?u=alext", totalCalls: 145, avgScore: 85, avgDuration: "04:30", conversionRate: "12%" },
    { id: "uuid-2", name: "Ivan K.", avatarUrl: "https://i.pravatar.cc/150?u=ivank", totalCalls: 210, avgScore: 92, avgDuration: "06:15", conversionRate: "18%" },
    { id: "uuid-3", name: "Elena S.", avatarUrl: "https://i.pravatar.cc/150?u=elenas", totalCalls: 180, avgScore: 75, avgDuration: "03:45", conversionRate: "9%" },
    { id: "uuid-4", name: "Jack S.", avatarUrl: "https://i.pravatar.cc/150?u=jacks", totalCalls: 195, avgScore: 98, avgDuration: "03:49", conversionRate: "22%" },
];

// 📌 МАХ КОЛ-ВО БЛОКОВ (12)
const generateMockBlocks = (baseScore: number) => {
    const blockNames = [
        "Приветствие и установление контакта",
        "Программирование диалога",
        "Сбор информации перед КП",
        "Квалификация (BANT/CHAMP)",
        "Презентация решения",
        "Озвучивание цены / тарифов",
        "Работа с возражениями",
        "Upsell / Cross-sell",
        "Достижение договоренностей (Next steps)",
        "Фиксация договоренностей (Follow up)",
        "Соблюдение регламента заполнения CRM",
        "Завершение диалога"
    ];

    return blockNames.map((name, i) => {
        // Рандомный скор от baseScore - 10 до baseScore + 10, ограниченный 0-100
        let val = Math.floor(baseScore + Math.random() * 20 - 10);
        if (val > 100) val = 100;
        if (val < 0) val = 0;
        const feedbackText = `Саммари по критерию «${name}»: ${val >= 80 ? 'Менеджер отлично справился с данным блоком, выполнив все требования чек-листа.' : val >= 50 ? 'Блок закрыт частично. Желательно проявлять больше инициативы, например, задавать более открытые вопросы.' : 'Критическая ошибка или полное отсутствие отработки по данному блоком. Рекомендуется прослушать звонок вместе с РОПом.'}`;
        return {
            id: `block-${i}`,
            name,
            score: val,
            maxScore: 100,
            feedback: feedbackText,
            criteria: [
                { id: 1, name: `${name} — основной критерий`, score: val >= 50 ? 1 : 0, maxScore: 1, feedback: feedbackText, quote: '' },
            ],
        };
    });
};

export const mockCalls: ManagerCall[] = [
    {
        id: "call-1",
        name: "Alex T.",
        avatarUrl: "https://i.pravatar.cc/150?u=alext",
        callDuration: "04:32",
        date: "Сегодня, 14:30",
        score: 85,
        audioUrl: "#",
        hasRecording: false,
        kommoUrl: "https://kommo.com/leads/123",
        transcript: "Клиент: Алло, добрый день. Меня интересует ваше предложение по закупкам.\nМенеджер: Здравствуйте! Да, конечно. Давайте обсудим объемы, которые вам требуются на этот квартал...",
        aiFeedback: "Менеджер отлично начал разговор, но забыл уточнить сроки поставки на первом этапе. Тон общения: вежливый. Отработка возражений: 8/10.",
        summary: "Клиент заинтересовался закупками на текущий квартал. Менеджер провел базовую презентацию, но упустил сроки поставки. Договорились о повторном созвоне в пятницу.",
        blocks: generateMockBlocks(85)
    },
    {
        id: "call-2",
        name: "Ivan K.",
        avatarUrl: "https://i.pravatar.cc/150?u=ivank",
        callDuration: "06:15",
        date: "Сегодня, 12:15",
        score: 92,
        audioUrl: "#",
        hasRecording: false,
        kommoUrl: "https://kommo.com/leads/124",
        transcript: "Клиент: Нам дорого.\nМенеджер: Понимаю вас. Если мы разобьем платеж на три части и добавим расширенную поддержку, это уложится в ваш бюджет?",
        aiFeedback: "Идеальная отработка возражения по цене. Менеджер сразу перевел диалог в конструктивное русло и предложил альтернативу.",
        summary: "Сложный клиент со строгим бюджетом. Возражение 'Дорого' отработано предложением разбивки платежа и бонусной поддержки. Клиент ушел думать до завтра.",
        blocks: generateMockBlocks(92)
    },
    {
        id: "call-3",
        name: "Elena S.",
        avatarUrl: "https://i.pravatar.cc/150?u=elenas",
        callDuration: "03:45",
        date: "Вчера, 16:40",
        score: 45,
        audioUrl: "#",
        hasRecording: false,
        kommoUrl: "https://kommo.com/leads/125",
        transcript: "Клиент: Я подумаю.\nМенеджер: Хорошо, как надумаете — звоните. До свидания.",
        aiFeedback: "Критическая ошибка: менеджер отпустил клиента без попытки назначить следующий шаг или закрыть возражение 'Я подумаю'.",
        summary: "Звонок закончился классическим 'Я подумаю'. Менеджер не стал дожимать или выяснять истинную причину отложенного решения.",
        blocks: generateMockBlocks(45)
    },
    {
        id: "call-4",
        name: "Jack S.",
        avatarUrl: "https://i.pravatar.cc/150?u=jacks",
        callDuration: "03:49",
        date: "Вчера, 10:05",
        score: 98,
        audioUrl: "#",
        hasRecording: false,
        kommoUrl: "https://kommo.com/leads/126",
        transcript: "Клиент: Давайте подписывать договор.\nМенеджер: Отлично. Отправляю вам ссылку на подписание, параллельно зафиксирую бонусы за этот месяц.",
        aiFeedback: "Быстрое и уверенное закрытие сделки. Четкое озвучивание следующих шагов.",
        summary: "Горячий клиент. Звонок прошел по идеальному сценарию, сразу перешли к подписанию контракта с сохранением бонусов текущего месяца.",
        blocks: generateMockBlocks(98)
    },
];

// 📌 ЗАГЛУШКИ: Дейли показатели
export const dailyMetrics = {
    funnel: [
        { label: "Сделок на активных этапах, шт.", value: "450" },
        { label: "Менеджеров на линии, всего", value: "12" },
        { label: "Всего лидов план, шт.", value: "100" },
        { label: "Всего лидов факт, шт.", value: "85" },
        { label: "Всего квал лидов план", value: "40" },
        { label: "Всего квал лидов факт", value: "38" },
        { label: "% квал. лидов", value: "44%" },
        { label: "A2", value: "15" },
        { label: "B1", value: "10" },
        { label: "B2 и выше", value: "13" },
        { label: "Ср. портфель менеджера", value: "37" },
        { label: "Направлено заданий всего", value: "210" },
        { label: "Направлено заданий новые", value: "45" },
        { label: "Конверсия (квал -> задание)", value: "35%" },
        { label: "Передано на консультацию всего", value: "180" },
        { label: "Передано на консультацию новые", value: "30" },
        { label: "Конверсия (задание -> консультация)", value: "66%" },
        { label: "Переданы на термин всего", value: "120" },
        { label: "Переданы на термин новые", value: "25" },
        { label: "Ожидают термин всего, шт.", value: "40" },
        { label: "Ожидают термин новые, шт.", value: "15" },
        { label: "Конверсия: консультация -> термин", value: "83%" },
        { label: "Термин ДЦ отменен/перенесен", value: "5" },
        { label: "Термин ДЦ состоялся, шт.", value: "20" },
        { label: "Переведены на термин АА, шт.", value: "8" },
        { label: "Термин АА отменен/перенесен", value: "2" },
        { label: "Термин АА, шт.", value: "6" },
        { label: "На рассмотрении бератера", value: "14" },
        { label: "Отложенный старт", value: "7" },
        { label: "Апелляция", value: "3" },
        { label: "Одобрено гутшайнов, шт", value: "11" },
        { label: "Отказ бератора (октябрь)", value: "2" },
        { label: "Подано апелляций, шт.", value: "3" },
    ],
    qualifier: [
        { label: "Кол-во сотрудников", value: "5" },
        { label: "Количество звонков план", value: "500" },
        { label: "Количество звонков факт", value: "480" },
        { label: "Дозвон от 1 сек.", value: "350" },
        { label: "Всего на линии (мин) план", value: "1200" },
        { label: "Всего на линии (мин) факт", value: "1150" },
        { label: "Ср. время в диалоге на сотр.", value: "3:45" },
        { label: "Ср. время диалога мин.", value: "2:30" },
        { label: "Ср. время ожидания ответа план (сек)", value: "15" },
        { label: "Ср. время ожидания ответа факт (сек)", value: "12" },
        { label: "% дозвона факт", value: "70%" },
        { label: "Пропущенные входящие, шт.", value: "8" },
        { label: "Просроченные задачи", value: "2" },
        { label: "Выполнение регламента, %", value: "95%" },
        { label: "Ср. кол-во касаний на лид", value: "2.4" },
        { label: "SLA (мин) план", value: "10" },
        { label: "SLA (мин) факт", value: "8" },
        { label: "ОКК план", value: "90%" },
        { label: "ОКК факт", value: "92%" }
    ],
    secondLine: [
        { label: "Кол-во сотрудников", value: "7" },
        { label: "Количество звонков план", value: "300" },
        { label: "Количество звонков факт", value: "290" },
        { label: "Дозвон от 1 сек.", value: "250" },
        { label: "Всего на линии (мин) план", value: "1500" },
        { label: "Всего на линии (мин) факт", value: "1480" },
        { label: "Ср. время в диалоге на сотр.", value: "4:20" },
        { label: "Ср. время диалога мин.", value: "3:15" },
        { label: "Ср. время ожидания ответа план (сек)", value: "20" },
        { label: "Ср. время ожидания ответа факт (сек)", value: "18" },
        { label: "% дозвона факт", value: "86%" },
        { label: "Пропущенные входящие, шт.", value: "3" },
        { label: "Просроченные задачи", value: "1" },
        { label: "Выполнение регламента, %", value: "98%" },
        { label: "Ср. кол-во касаний на лид", value: "1.8" },
        { label: "TLT", value: "14" },
        { label: "SLA (мин) план", value: "15" },
        { label: "SLA (мин) факт", value: "12" },
        { label: "ОКК план", value: "90%" },
        { label: "ОКК факт", value: "94%" }
    ]
};
