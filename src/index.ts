interface CoinData {
	id: string; // 代币唯一标识
	symbol: string; // 代币符号
	name: string; // 代币名称
	current_price: number; // 当前价格
	market_cap: number; // 市值
	market_cap_rank: number; // 市值排名
	total_volume: number; // 24小时交易量
	high_24h: number; // 24小时最高价
	low_24h: number; // 24小时最低价
	price_change_percentage_24h: number; // 24小时价格变动百分比
	// 其他可能的字段...
}
export interface Env {
	coingecko: KVNamespace;
}

async function fetchTop500Tokens(): Promise<CoinData[] | null> {
	const API_URL = 'https://api.coingecko.com/api/v3/coins/markets';
	const vsCurrency = 'usd'; // 目标货币
	const order = 'market_cap_desc'; // 按市值降序排列
	const perPage = 250; // 每页返回代币数量
	const pages = [1, 2]; // 分页：前 500 个代币需要两页数据

	try {
		let allTokens: CoinData[] = []; // 初始化结果数组

		for (const page of pages) {
			const params = new URLSearchParams({
				vs_currency: vsCurrency,
				order,
				per_page: perPage.toString(),
				page: page.toString(),
				sparkline: 'false', // 默认不需要 sparkline 数据
			});

			const response = await fetch(`${API_URL}?${params}`, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
				},
			});
			if (!response.ok) {
				throw new Error(`Failed to fetch page ${page}: ${response.statusText}`);
			}

			const data: CoinData[] = await response.json(); // 确保返回的数据符合 CoinData 类型
			allTokens = [...allTokens, ...data];
		}

		console.log(`Fetched ${allTokens.length} tokens successfully!`);
		return allTokens; // 返回所有代币数据
	} catch (error: unknown) {
		console.error('Error fetching top 500 tokens:', error);
		return null; // 如果出错，返回 null
	}
}

async function fetchIntersectionByDateRange(startDate: Date, endDate: Date, limit: number, env: Env): Promise<Response> {
	if (startDate > endDate) {
		return new Response('Invalid date range: start_date must be earlier than end_date.', { status: 400 });
	}

	let currentDate = new Date(startDate);
	const datesData: CoinData[][] = [];

	// 遍历日期范围，获取每一天的数据
	while (currentDate <= endDate) {
		const formattedDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(
			currentDate.getDate()
		).padStart(2, '0')}`;

		const value = await env.coingecko.get(formattedDate);
		if (value) {
			const parsedData: CoinData[] = JSON.parse(value);
			const limitedData = limit > 0 ? parsedData.slice(0, limit) : parsedData;
			datesData.push(limitedData);
		}
		currentDate.setDate(currentDate.getDate() + 1);
	}

	if (datesData.length === 0) {
		return new Response('No data found for the specified date range.', { status: 404 });
	}

	// 计算交集：在所有日期中都出现的代币
	const intersection = datesData.reduce((commonTokens, currentTokens) => {
		const currentTokenIds = new Set(currentTokens.map((token) => token.id));
		return commonTokens.filter((token) => currentTokenIds.has(token.id));
	}, datesData[0]);

	// 记录被过滤掉的代币
	const allTokenIds = new Set(datesData.flat().map((token) => token.id));
	const intersectionIds = new Set(intersection.map((token) => token.id));
	const filteredOutTokens = Array.from(allTokenIds).filter((id) => !intersectionIds.has(id));

	// 按市值降序排序
	intersection.sort((a, b) => b.market_cap - a.market_cap);

	// 限制返回结果数量
	const limitedResult = limit > 0 ? intersection.slice(0, limit) : intersection;

	// 提取代币符号列表
	const symbolList = limitedResult.map((token) => token.symbol.toUpperCase());
	const filteredOutSymbols = filteredOutTokens.map(
		(id) =>
			datesData
				.flat()
				.find((token) => token.id === id)
				?.symbol.toUpperCase() || id.toUpperCase()
	);

	// 返回包含交集和被过滤掉的交易对
	return new Response(
		JSON.stringify({
			pairlist: symbolList,
			filteredOut: filteredOutSymbols,
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}
	);
}


export default {
	async scheduled(event, env, ctx): Promise<void> {
		const today = new Date();

		const year = today.getFullYear();
		const month = String(today.getMonth() + 1).padStart(2, '0');
		const day = String(today.getDate()).padStart(2, '0');

		const formattedDate = `${year}-${month}-${day}`;
		const top500Tokens = await fetchTop500Tokens(); // 加上 await 确保获取到数据
		if (top500Tokens) {
			console.log(`Fetched ${top500Tokens.length} tokens!`);
			await env.coingecko.put(formattedDate, JSON.stringify(top500Tokens));
		} else {
			console.error('Failed to fetch top 500 tokens.'); // 错误处理
		}
	},
	async fetch(request, env, ctx): Promise<Response> {
		try {
			const url = new URL(request.url);

			// 参数解析
			const days = parseInt(url.searchParams.get('days') || '0'); // 最近几天
			const limit = parseInt(url.searchParams.get('limit') || '0'); // 限制返回结果的代币数量

			// 如果传入 `days` 参数，自动计算日期范围
			if (days > 0) {
				const today = new Date();
				const startDate = new Date();
				startDate.setDate(today.getDate() - (days - 1)); // 计算起始日期（包括今天）

				// 调用封装好的通用处理逻辑
				return await fetchIntersectionByDateRange(startDate, today, limit, env);
			}

			// 如果没有提供 `days` 参数，则认为是常规日期范围计算
			const startDateParam = url.searchParams.get('start_date');
			const endDateParam = url.searchParams.get('end_date');
			if (!startDateParam || !endDateParam) {
				return new Response('Missing start_date or end_date, or days parameter.', { status: 400 });
			}

			// 转换日期范围
			const startDate = new Date(startDateParam);
			const endDate = new Date(endDateParam);
			if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
				return new Response('Invalid date format. Use YYYY-MM-DD.', { status: 400 });
			}

			// 调用封装好的通用处理逻辑
			return await fetchIntersectionByDateRange(startDate, endDate, limit, env);
		} catch (err) {
			console.error(`Error processing request: ${err}`);
			return new Response('Internal Server Error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
