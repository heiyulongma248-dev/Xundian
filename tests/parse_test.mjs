// parseBookMetadata 自动测试台
//
// 跑法：node tests/parse_test.mjs
//
// 工作方式：
//   1. 读 web/app.js
//   2. 抠出 _CITIES → parseBookMetadata 整段（行号区间硬编码，跟 app.js 同步）
//   3. eval 到本进程，拿到 parseBookMetadata
//   4. 跑下面的 CASES 数组，比对 expected
//
// expected 里只列出关心的字段 —— 其它字段不强制比对。
// 如果 expected.foo = '' 表示「显式期望该字段为空」。
// 如果 expected 里没列 foo，就不检查 foo。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(__dirname, '..', 'web', 'app.js');

// —— 抠出 parseBookMetadata 及其依赖（_CITIES / _PUBLISHER_TO_CITY / _inParens） ——
const src = fs.readFileSync(APP_JS, 'utf8');
const startMarker = '// 常见出版地城市表';
const endMarker = '\nasync function editBookMeta';
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);
if (startIdx < 0 || endIdx < 0) {
  console.error('FATAL: 找不到 parseBookMetadata 的代码区间，请检查 marker');
  process.exit(2);
}
const extracted = src.slice(startIdx, endIdx);

// eval 到一个隔离的对象上
const sandbox = {};
const fnBody = `${extracted}; return { parseBookMetadata, _CITIES, _PUBLISHER_TO_CITY };`;
const loader = new Function(fnBody);
const { parseBookMetadata } = loader();

// —— 测试用例 ——
const CASES = [
  // ========== 标准 GB/T 7714 ==========
  {
    name: '标准 GB/T 7714',
    input: '胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001.',
    expect: { author: '胡适', title: '胡适日记全编', doc_type: 'M', place: '合肥', publisher: '安徽教育出版社', year: '2001' },
  },
  {
    name: '书名含冒号（汉字 + 半角冒号）',
    input: '汤一介. 中国儒学史: 现代卷[M]. 北京: 北京大学出版社, 2011.',
    expect: { author: '汤一介', title: '中国儒学史: 现代卷', doc_type: 'M', place: '北京', publisher: '北京大学出版社', year: '2011' },
  },
  {
    name: '书名含全角冒号 + 第N卷',
    input: '胡适. 胡适全集：第23卷[M]. 合肥: 安徽教育出版社, 2003.',
    expect: { author: '胡适', title: '胡适全集：第23卷', doc_type: 'M', place: '合肥', publisher: '安徽教育出版社', year: '2003' },
  },
  {
    name: '版本标记（修订版）应被剥离',
    input: '黄仁宇. 万历十五年[M]. 修订版. 北京: 中华书局, 2007.',
    expect: { author: '黄仁宇', title: '万历十五年', place: '北京', publisher: '中华书局', year: '2007' },
  },

  // ========== 《》书名号 ==========
  {
    name: '《》书名号优先',
    input: '曹雪芹. 《红楼梦》[M]. 北京: 人民文学出版社, 1982.',
    expect: { author: '曹雪芹', title: '红楼梦', place: '北京', publisher: '人民文学出版社', year: '1982' },
  },

  // ========== 主作者标记（无 [M]） ==========
  {
    name: '作者带"著"标记',
    input: '钱穆 著. 国史大纲. 商务印书馆, 1996.',
    expect: { author: '钱穆', title: '国史大纲', publisher: '商务印书馆', place: '北京', year: '1996' },
  },

  // ========== 次要贡献者剥离 ==========
  {
    name: '次要贡献者：name + , + 整理',
    input: '胡适. 胡适日记全编[M]. 曹伯言,整理. 合肥: 安徽教育出版社, 2001.',
    expect: { author: '胡适', title: '胡适日记全编', publisher: '安徽教育出版社', year: '2001', place: '合肥' },
  },
  {
    name: '次要贡献者：多人 + 整理',
    input: '胡适. 胡适书信集[M]. 耿云志，欧阳哲生，整理. 北京: 北京大学出版社, 1996.',
    expect: { author: '胡适', title: '胡适书信集', publisher: '北京大学出版社', year: '1996', place: '北京' },
  },
  {
    name: '次要贡献者：无逗号（曹波整理）',
    input: '胡适 请回答1998 曹波整理 2003 安徽出版社',
    expect: { author: '胡适', title: '请回答1998', publisher: '安徽出版社', year: '2003' },
  },
  {
    name: '次要贡献者在 publisher 后',
    input: '胡适 请回答1998 安徽出版社 2003 曹波整理',
    expect: { author: '胡适', title: '请回答1998', publisher: '安徽出版社', year: '2003' },
  },

  // ========== 年份评分 ==========
  {
    name: '书名里含年份：请回答1998 + 真年份 2003',
    input: '胡适. 请回答1998[M]. 合肥: 安徽教育出版社, 2003.',
    expect: { author: '胡适', title: '请回答1998', year: '2003', publisher: '安徽教育出版社', place: '合肥' },
  },
  {
    name: '括号里的年份范围应被忽略',
    input: '王某. 中国近现代史 (1949-1979)[M]. 北京: 中华书局, 2010.',
    expect: { author: '王某', year: '2010', publisher: '中华书局', place: '北京' },
  },
  {
    name: '年份带"年出版"后缀',
    input: '胡适 请回答1998 曹波整理 2003年出版 安徽出版社',
    expect: { author: '胡适', title: '请回答1998', year: '2003', publisher: '安徽出版社' },
  },
  {
    name: '年份带"年出版"在末尾',
    input: '胡适 请回答1998 曹波整理 安徽出版社 2003年出版',
    expect: { author: '胡适', title: '请回答1998', year: '2003', publisher: '安徽出版社' },
  },

  // ========== 出版地 ==========
  {
    name: '省名作 place（用户输入是省）',
    input: '胡适 胡适全集 2003 安徽出版社 曹波整理 安徽',
    expect: { author: '胡适', title: '胡适全集', place: '安徽', publisher: '安徽出版社', year: '2003' },
  },
  {
    name: '省名 place 在 publisher 前',
    input: '胡适 胡适全集 安徽 安徽出版社 2003',
    expect: { author: '胡适', title: '胡适全集', place: '安徽', publisher: '安徽出版社', year: '2003' },
  },
  {
    name: 'place 不存在时不应被 publisher 名误抓',
    input: '胡适 胡适全集 安徽出版社 2003',
    expect: { author: '胡适', title: '胡适全集', place: '', publisher: '安徽出版社', year: '2003' },
  },
  {
    name: '出版社映射兜底 place（黄山书社→合肥）',
    input: '胡适. 胡适日记[M]. 黄山书社, 2003.',
    expect: { author: '胡适', title: '胡适日记', publisher: '黄山书社', place: '合肥', year: '2003' },
  },
  {
    name: '南京大屠杀史不要被 place=南京 false-positive',
    input: '张三. 南京大屠杀史[M]. 北京: 商务印书馆, 2010.',
    expect: { author: '张三', title: '南京大屠杀史', place: '北京', publisher: '商务印书馆', year: '2010' },
  },

  // ========== 国籍方括号 [美] ==========
  {
    name: '作者前的 [美] 国籍方括号应保留',
    input: '[美] 罗伯特·达恩顿. 启蒙运动的生意[M]. 北京: 三联书店, 2005.',
    expect: { title: '启蒙运动的生意', place: '北京', publisher: '三联书店', year: '2005' },
    // author 含 "[美]" 我们不强制，太多变种 — 只保证 title/publisher 正确
  },

  // ========== 稀疏输入（无标点） ==========
  {
    name: '稀疏：3 字段（作者 + 书名 + 出版社）',
    input: '胡适 胡适日记 安徽教育出版社',
    expect: { author: '胡适', title: '胡适日记', publisher: '安徽教育出版社', place: '合肥' },
  },
  {
    name: '稀疏：4 字段',
    input: '胡适 胡适日记 安徽教育出版社 2001',
    expect: { author: '胡适', title: '胡适日记', publisher: '安徽教育出版社', place: '合肥', year: '2001' },
  },
  {
    name: '稀疏：5 字段（书名最长应被选中）',
    input: '胡适 胡适全集中册 安徽 安徽出版社 2003',
    expect: { author: '胡适', title: '胡适全集中册', place: '安徽', publisher: '安徽出版社', year: '2003' },
  },

  // ========== 边缘情况 ==========
  {
    name: '空输入',
    input: '',
    expect: { author: '', title: '', publisher: '', year: '', place: '', doc_type: '' },
  },
  {
    name: '只有空白',
    input: '   　　  ',
    expect: { author: '', title: '', publisher: '', year: '' },
  },
  {
    name: '无 publisher / 无 year',
    input: '胡适. 胡适日记[M]. 北京.',
    expect: { author: '胡适', title: '胡适日记', place: '北京', year: '', publisher: '' },
  },
  {
    name: '无 year 但有 publisher',
    input: '胡适. 胡适日记[M]. 北京: 中华书局.',
    expect: { author: '胡适', title: '胡适日记', place: '北京', publisher: '中华书局', year: '' },
  },

  // ========== 复合出版社名 ==========
  {
    name: '复合出版社：中国大百科全书出版社',
    input: '张三. 词典[M]. 北京: 中国大百科全书出版社, 2018.',
    expect: { author: '张三', publisher: '中国大百科全书出版社', place: '北京', year: '2018' },
  },

  // ========== 多作者 ==========
  {
    name: '多作者用逗号分隔',
    input: '葛兆光, 王汎森. 思想史研究[M]. 北京: 中华书局, 2008.',
    expect: { title: '思想史研究', publisher: '中华书局', place: '北京', year: '2008' },
    // author 取首位 葛兆光 还是 全部？— 不强检
  },

  // ========== 全角数字 ==========
  {
    name: '全角数字应归一化',
    input: '胡适. 胡适日记[M]. 北京: 中华书局, ２００１.',
    expect: { year: '2001', publisher: '中华书局', place: '北京' },
  },

  // ========== 主作者关键字"等" ==========
  {
    name: '作者带"等著"',
    input: '张三 等著. XX史[M]. 北京: 中华书局, 2020.',
    expect: { title: 'XX史', publisher: '中华书局', place: '北京', year: '2020' },
  },

  // ========== 极简：只有一个 token ==========
  {
    name: '只有书名一个 token',
    input: '胡适日记',
    expect: { title: '胡适日记' },
  },

  // ========================================================
  //                  第二批：刁钻 / 角落用例
  // ========================================================

  // ---------- 文献类型 J / N ----------
  {
    name: '期刊 [J]',
    input: '王某. 论某事[J]. 历史研究, 2018(3): 45-60.',
    expect: { author: '王某', doc_type: 'J', year: '2018' },
  },
  {
    name: '报纸 [N]',
    input: '李某. 改革谈[N]. 人民日报, 2020-08-15(05).',
    expect: { author: '李某', doc_type: 'N', year: '2020' },
  },

  // ---------- 多个 [M] / 错乱标记 ----------
  {
    name: '小写 [m] 也应识别',
    input: '胡适. 胡适日记[m]. 北京: 中华书局, 2001.',
    expect: { doc_type: 'M', author: '胡适', title: '胡适日记' },
  },

  // ---------- 译者 ----------
  {
    name: '译者标记（译）',
    input: '[美] 福山. 历史的终结[M]. 黄胜强, 译. 北京: 中国社会科学出版社, 2003.',
    expect: { title: '历史的终结', publisher: '中国社会科学出版社', place: '北京', year: '2003' },
  },

  // ---------- 出版社多种后缀 ----------
  {
    name: '出版集团',
    input: '张三. XX[M]. 北京: 中国出版集团, 2019.',
    expect: { publisher: '中国出版集团', year: '2019', place: '北京' },
  },
  {
    name: '书店',
    input: '张三. XX[M]. 北京: 三联书店, 2019.',
    expect: { publisher: '三联书店', place: '北京', year: '2019' },
  },
  {
    name: '巴蜀书社（书社后缀）',
    input: '张三. 蜀学[M]. 巴蜀书社, 2015.',
    expect: { publisher: '巴蜀书社', place: '成都', year: '2015' },
  },

  // ---------- 年份各种边界 ----------
  {
    name: '两位作者 + 三个年份候选',
    input: '张三, 李四. 中国近现代史 (1840-1949)[M]. 北京: 商务印书馆, 2015.',
    expect: { year: '2015', publisher: '商务印书馆', place: '北京' },
  },
  {
    name: '只出现年份范围（无单独出版年）',
    input: '张三. 1949-1979[M]. 北京: 商务印书馆.',
    expect: { publisher: '商务印书馆', place: '北京' },
    // year 不强检（含糊场景）
  },
  {
    name: '2003 年版 后缀',
    input: '胡适 胡适日记 安徽教育出版社 2003年版',
    expect: { year: '2003', publisher: '安徽教育出版社', place: '合肥' },
  },

  // ---------- 字段顺序乱七八糟 ----------
  {
    name: '出版社在最前',
    input: '安徽教育出版社. 胡适. 胡适日记[M]. 合肥, 2001.',
    expect: { publisher: '安徽教育出版社', place: '合肥', year: '2001' },
  },
  {
    name: '年份在最前',
    input: '2001. 胡适. 胡适日记[M]. 合肥: 安徽教育出版社.',
    expect: { year: '2001', publisher: '安徽教育出版社' },
  },

  // ---------- 极端稀疏 ----------
  {
    name: '只有出版社',
    input: '中华书局',
    expect: { publisher: '中华书局', place: '北京' },
  },
  {
    name: '只有年份',
    input: '2001',
    expect: { year: '2001' },
  },
  {
    name: '5+ 个 token 都没明显标记',
    input: '胡适 胡适全集中册下编 安徽 合肥 2003 安徽教育出版社',
    expect: { author: '胡适', title: '胡适全集中册下编', publisher: '安徽教育出版社', year: '2003' },
    // place 接受 安徽 或 合肥（第一个命中的）
  },

  // ---------- 标点干扰 ----------
  {
    name: '末尾大量分号',
    input: '胡适. 胡适日记[M]. 合肥: 安徽教育出版社, 2001;;;',
    expect: { author: '胡适', title: '胡适日记', year: '2001', publisher: '安徽教育出版社' },
  },
  {
    name: '中英文混用标点',
    input: '胡适, 胡适日记[M]. 合肥: 安徽教育出版社; 2001。',
    expect: { author: '胡适', title: '胡适日记', publisher: '安徽教育出版社', place: '合肥', year: '2001' },
  },

  // ---------- 长书名 / 副标题 ----------
  {
    name: '长书名带破折号副标题',
    input: '王某. 论中国——从历史看未来[M]. 北京: 中华书局, 2018.',
    expect: { author: '王某', publisher: '中华书局', place: '北京', year: '2018' },
  },
  {
    name: '书名带括号',
    input: '王某. 中国史(上册)[M]. 北京: 中华书局, 2018.',
    expect: { author: '王某', publisher: '中华书局', place: '北京', year: '2018' },
  },

  // ---------- 出版社映射特殊 ----------
  {
    name: '上海古籍出版社→上海',
    input: '钱钟书. 管锥编[M]. 上海古籍出版社, 1979.',
    expect: { publisher: '上海古籍出版社', place: '上海', year: '1979' },
  },
  {
    name: '广西师范大学出版社→桂林',
    input: '张三. 旁观者[M]. 广西师范大学出版社, 2015.',
    expect: { publisher: '广西师范大学出版社', place: '桂林', year: '2015' },
  },

  // ---------- 复合主作者标记（不应误剥） ----------
  {
    name: '编著不应被吃掉',
    input: '王某 编著. XX史[M]. 北京: 中华书局, 2018.',
    expect: { title: 'XX史', publisher: '中华书局', place: '北京', year: '2018' },
  },
  {
    name: '编辑（次要） vs 编（主要）— "编辑"是次要',
    input: '胡适. 胡适日记[M]. 王二, 编辑. 北京: 中华书局, 2018.',
    expect: { author: '胡适', title: '胡适日记', publisher: '中华书局', place: '北京', year: '2018' },
  },

  // ---------- 用户极度偷懒 ----------
  {
    name: '稀疏 + 省名 + 年版后缀',
    input: '胡适 胡适日记 安徽 安徽教育出版社 2003年版',
    expect: { author: '胡适', title: '胡适日记', place: '安徽', publisher: '安徽教育出版社', year: '2003' },
  },
  {
    name: '稀疏 + 次要贡献者 + 省名',
    input: '胡适 胡适全集 曹波整理 安徽 安徽教育出版社 2003',
    expect: { author: '胡适', title: '胡适全集', place: '安徽', publisher: '安徽教育出版社', year: '2003' },
  },

  // ========================================================
  //                  第三批：更刁钻 / 真实世界乱输入
  // ========================================================

  // ---- 古籍 / 笺注 ----
  {
    name: '古籍 + 校注',
    input: '[清]顾炎武. 日知录集释[M]. 黄汝成, 集释. 上海古籍出版社, 2006.',
    expect: { title: '日知录集释', publisher: '上海古籍出版社', place: '上海', year: '2006' },
  },
  {
    name: '校点',
    input: '[宋]朱熹. 朱子语类[M]. 黎靖德, 校点. 北京: 中华书局, 1986.',
    expect: { title: '朱子语类', publisher: '中华书局', place: '北京', year: '1986' },
  },
  {
    name: '点校',
    input: '[清]章学诚. 文史通义校注[M]. 叶瑛, 点校. 北京: 中华书局, 1985.',
    expect: { title: '文史通义校注', publisher: '中华书局', place: '北京', year: '1985' },
  },

  // ---- 大学出版社变体 ----
  {
    name: '复旦大学出版社',
    input: '葛兆光. 中国思想史[M]. 复旦大学出版社, 2001.',
    expect: { publisher: '复旦大学出版社', place: '上海', year: '2001' },
  },
  {
    name: '清华大学出版社',
    input: '张三. 算法导论[M]. 北京: 清华大学出版社, 2013.',
    expect: { publisher: '清华大学出版社', place: '北京', year: '2013' },
  },

  // ---- 年份范围 + 实际出版年（评分挑战） ----
  {
    name: '历史时段 1840-1949 出现在书名中',
    input: '蒋廷黻. 中国近代史(1840-1949)[M]. 长沙: 岳麓书社, 2010.',
    expect: { year: '2010', publisher: '岳麓书社', place: '长沙' },
  },
  {
    name: '书名含两个早年份 + 一个真年份',
    input: '张三. 1937-1945抗战史 (再版)[M]. 北京: 中华书局, 2015.',
    expect: { year: '2015', publisher: '中华书局', place: '北京' },
  },

  // ---- 多次要贡献者 ----
  {
    name: '两个次要贡献者（分别 整理 + 注释）',
    input: '胡适. 胡适日记[M]. 曹伯言, 整理. 张三, 注释. 合肥: 安徽教育出版社, 2001.',
    expect: { author: '胡适', title: '胡适日记', year: '2001' },
  },

  // ---- 标题里有数字 ----
  {
    name: '书名: 1984',
    input: '[英]奥威尔. 1984[M]. 北京: 北京十月文艺出版社, 2010.',
    expect: { title: '1984', year: '2010' },
  },
  {
    name: '书名: 三体',
    input: '刘慈欣. 三体[M]. 重庆: 重庆出版社, 2008.',
    expect: { author: '刘慈欣', title: '三体', year: '2008' },
  },

  // ---- 无 [M] 的稀疏书目（"著"在中间） ----
  {
    name: '稀疏 + 著 + 出版社',
    input: '胡适著 胡适日记 安徽教育出版社 2001',
    expect: { title: '胡适日记', publisher: '安徽教育出版社', year: '2001' },
    // author 不强检 — "胡适著" 整体怎么处理可以容忍
  },

  // ---- 重复字段（坏输入） ----
  {
    name: '重复 publisher',
    input: '胡适. 胡适日记[M]. 北京: 中华书局, 中华书局, 2001.',
    expect: { publisher: '中华书局', year: '2001', place: '北京' },
  },
  {
    name: '重复 year（取后一个）',
    input: '胡适. 胡适日记[M]. 北京: 中华书局, 2001, 2001.',
    expect: { year: '2001' },
  },

  // ---- 全角括号 ----
  {
    name: '全角括号里的年份范围',
    input: '王某. 中国历史（1949—2019）[M]. 北京: 中华书局, 2020.',
    expect: { year: '2020', publisher: '中华书局', place: '北京' },
  },

  // ---- 异常前后缀 ----
  {
    name: '前面有 "参考文献:"',
    input: '参考文献: 胡适. 胡适日记[M]. 北京: 中华书局, 2001.',
    expect: { author: '胡适', title: '胡适日记', publisher: '中华书局', place: '北京', year: '2001' },
    // 不强检 author（可能含"参考文献:"前缀），但 publisher/year 必须对
  },
  {
    name: '末尾有页码',
    input: '胡适. 胡适日记[M]. 北京: 中华书局, 2001: 25-30.',
    expect: { year: '2001', publisher: '中华书局', place: '北京' },
  },

  // ---- 用 / 分割多个字段 ----
  {
    name: '斜杠分隔（不规范但常见复制粘贴）',
    input: '胡适/胡适日记[M]/北京/中华书局/2001',
    expect: { publisher: '中华书局', year: '2001' },
  },

  // ---- 主作者标记吃错（"撰" / "选编"） ----
  {
    name: '主作者带"撰"',
    input: '司马迁 撰. 史记. 北京: 中华书局, 1959.',
    expect: { title: '史记', publisher: '中华书局', place: '北京', year: '1959' },
  },
  {
    name: '主作者带"选编"',
    input: '李某 选编. 唐诗三百首. 上海: 上海古籍出版社, 2006.',
    expect: { title: '唐诗三百首', publisher: '上海古籍出版社', place: '上海', year: '2006' },
  },

  // ---- 极短作者名（单字） ----
  {
    name: '单字作者名（少见但合法）',
    input: '简. 简爱[M]. 北京: 商务印书馆, 2010.',
    expect: { title: '简爱', publisher: '商务印书馆', place: '北京', year: '2010' },
    // author 不强检（"简" 单字会被长度门限挡掉，可接受）
  },

  // ---- 出版社全名（出版有限公司） ----
  {
    name: '出版社"出版有限公司"后缀',
    input: '张三. XX[M]. 北京: 某某出版有限公司, 2020.',
    expect: { publisher: '某某出版有限公司', year: '2020' },
  },

  // ---- 用户极度偷懒（无空格） ----
  {
    name: '无空格的稀疏输入',
    input: '胡适胡适日记安徽教育出版社2001',
    expect: { publisher: '安徽教育出版社', year: '2001', place: '合肥' },
    // 没空格切不开 author/title 是正常的，只保证 publisher/year 抓到
  },

  // ========================================================
  //                  第四批：针对最近改动的 regression
  // ========================================================

  // ---- 新增的 comma-split 不应误剥（titleSegIdx === 0 但首段不像作者） ----
  {
    name: '首段含逗号但不是"作者,书名"结构（年份范围）',
    input: '中国近现代史 (1840, 1949)[M]. 北京: 中华书局, 2020.',
    expect: { publisher: '中华书局', place: '北京', year: '2020' },
    // 不应把 "中国近现代史 (1840" 当 author
  },
  {
    name: '首段含数字 — 不应被当 author',
    input: '1949抗战[M]. 北京: 中华书局, 2020.',
    expect: { publisher: '中华书局', year: '2020' },
  },

  // ---- 已知出版社 lookup：3a 锚定优先正确选 publisher ----
  {
    name: '描述里的 "商务印书馆出版" 不应被当 publisher，正确选 ": 中华书局"',
    input: '商务印书馆出版的书. 胡适日记[M]. 北京: 中华书局, 2001.',
    expect: { publisher: '中华书局', place: '北京', year: '2001' },
    // "商务印书馆" 在 position 0 无前导分隔符，3a 跳过它；
    // 后面 ": 中华书局" 是真的 publisher
  },

  // ---- place 优先级：用户显式 > map 兜底 ----
  {
    name: 'publisher 已知映射 + 用户显式 place（取用户）',
    input: '胡适. 胡适日记[M]. 上海: 中华书局, 2001.',
    expect: { publisher: '中华书局', place: '上海', year: '2001' },
    // 中华书局通常→北京，但用户写了"上海"，以用户为准
  },

  // ---- 英文出版社 ----
  {
    name: '英文出版社 + 英文书名',
    input: 'David Foster Wallace. Infinite Jest. Little Brown Publishing, 1996.',
    expect: { year: '1996' },
    // publisher 抓不抓到都行（test 重点：不应崩、不应误识别）
  },

  // ---- 多种 doc_type ----
  {
    name: 'doc_type = D (学位论文)',
    input: '张三. 某研究[D]. 北京: 北京大学, 2020.',
    expect: { doc_type: 'D', year: '2020' },
  },
  {
    name: 'doc_type = C (论文集)',
    input: '张三. 某论文[C]. 北京: 中华书局, 2018.',
    expect: { doc_type: 'C', publisher: '中华书局', year: '2018' },
  },

  // ---- 出版社 + 紧贴 ----
  {
    name: '出版社紧贴年份（中间逗号）',
    input: '胡适. 胡适日记[M]. 北京: 中华书局,2001.',
    expect: { publisher: '中华书局', year: '2001' },
  },
  {
    name: '出版社紧贴年份（无逗号）',
    input: '胡适. 胡适日记[M]. 北京: 中华书局 2001.',
    expect: { publisher: '中华书局', year: '2001' },
  },

  // ---- 次要贡献者刁钻角色 ----
  {
    name: '次要贡献者：校译',
    input: '柏拉图. 理想国[M]. 张三, 校译. 北京: 商务印书馆, 1986.',
    expect: { title: '理想国', publisher: '商务印书馆', place: '北京', year: '1986' },
  },
  {
    name: '次要贡献者：审定',
    input: '王五. 词典[M]. 李四, 审定. 北京: 商务印书馆, 2000.',
    expect: { publisher: '商务印书馆', place: '北京', year: '2000' },
  },

  // ---- 出版社包含「中国」前缀 ----
  {
    name: '中国社会科学出版社（长前缀）',
    input: '张三. XX[M]. 北京: 中国社会科学出版社, 2015.',
    expect: { publisher: '中国社会科学出版社', place: '北京', year: '2015' },
  },

  // ---- 仅 [M] 没其它信息 ----
  {
    name: '只有书名 + [M]',
    input: '胡适日记[M]',
    expect: { doc_type: 'M', title: '胡适日记' },
  },

  // ---- 真实复制粘贴：中文论文常见格式 ----
  {
    name: '完整 GB/T 7714（含 ISBN 一类无关尾巴）',
    input: '[1] 胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001: 25-30.',
    expect: { author: '胡适', title: '胡适日记全编', publisher: '安徽教育出版社', place: '合肥', year: '2001' },
  },

  // ========== 新增字段测试 ==========
  {
    name: '历史研究体例 — 暴露 role=主编',
    input: '任继愈主编：《中国哲学发展史（先秦卷）》，北京：人民出版社，1983年，第25页。',
    expect: { author: '任继愈', role: '主编', title: '中国哲学发展史（先秦卷）', place: '北京', publisher: '人民出版社', year: '1983' },
  },
  {
    name: '历史研究体例 — 著（自动归一化为空）',
    input: '赵景深著：《文坛忆旧》，上海：北新书局，1948年，第43页。',
    expect: { author: '赵景深', role: '', title: '文坛忆旧', place: '上海', publisher: '北新书局', year: '1948' },
  },
  {
    name: '法学手册 — edition 数字',
    input: '黄仁宇：《万历十五年》（第2版），中华书局2007年版，第1页。',
    expect: { author: '黄仁宇', title: '万历十五年', edition: '2', publisher: '中华书局', year: '2007' },
  },
  {
    name: '修订版 → edition="修订"',
    input: '黄仁宇. 万历十五年[M]. 修订版. 北京: 中华书局, 2007.',
    expect: { author: '黄仁宇', title: '万历十五年', edition: '修订', place: '北京', publisher: '中华书局', year: '2007' },
  },

  // ========== country / translator ==========
  {
    name: 'country [日] 前缀',
    input: '[日]实藤惠秀：《中国人留学日本史》，谭汝谦、林启彦译，香港：中文大学出版社，1982年，第11-12页。',
    expect: { country: '日', author: '实藤惠秀', translator: '谭汝谦、林启彦', title: '中国人留学日本史', place: '香港', publisher: '中文大学出版社', year: '1982' },
  },
  {
    name: 'country [美] + 全角 ［］',
    input: '［美］斐迪南·滕尼斯：《共同体与社会》，林荣远译，北京：商务印书馆，1999年，第4页。',
    expect: { country: '美', author: '斐迪南·滕尼斯', translator: '林荣远', title: '共同体与社会', place: '北京', publisher: '商务印书馆', year: '1999' },
  },
  {
    name: 'translator — 单译者',
    input: '蒙森：《罗马史》，李稼年译，北京：商务印书馆，2014年，第3页。',
    expect: { author: '蒙森', translator: '李稼年', title: '罗马史', place: '北京', publisher: '商务印书馆', year: '2014' },
  },
  {
    name: '无 country：[M] 标签不应被当成 country',
    input: '胡适. 胡适日记全编[M]. 合肥: 安徽教育出版社, 2001.',
    expect: { country: '', author: '胡适', title: '胡适日记全编', doc_type: 'M' },
  },
];

// —— 跑测试 ——
let passed = 0;
let failed = 0;
const fails = [];

for (const c of CASES) {
  const got = parseBookMetadata(c.input);
  const diffs = [];
  for (const key of Object.keys(c.expect)) {
    const expected = c.expect[key];
    const actual = got[key];
    if (actual !== expected) {
      diffs.push({ key, expected, actual });
    }
  }
  if (diffs.length === 0) {
    passed++;
  } else {
    failed++;
    fails.push({ name: c.name, input: c.input, diffs, got });
  }
}

// —— 输出 ——
console.log(`\n=== parseBookMetadata 测试 ===`);
console.log(`总用例: ${CASES.length}  ✓ ${passed}  ✗ ${failed}\n`);

if (fails.length > 0) {
  for (const f of fails) {
    console.log(`✗ ${f.name}`);
    console.log(`  输入: ${JSON.stringify(f.input)}`);
    for (const d of f.diffs) {
      console.log(`    ${d.key}: expected=${JSON.stringify(d.expected)}, actual=${JSON.stringify(d.actual)}`);
    }
    // 也打印完整 got，方便看其它字段
    const compact = {};
    for (const k of ['author', 'title', 'doc_type', 'place', 'publisher', 'year']) {
      if (f.got[k]) compact[k] = f.got[k];
    }
    console.log(`    完整结果: ${JSON.stringify(compact)}`);
    console.log('');
  }
  process.exit(1);
}
process.exit(0);
