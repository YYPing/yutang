/**
 * 层②补图的**生图 prompt**（2026-10-08）。
 *
 * ⚠️ 这个文件不参与构建，也**不参与运行**——它是「生图这一步的人工口径」。
 *   之所以写进仓库而不是临时写在对话里：
 *   ① 上一轮「图生图重画 4 张」失败时（强制水印 + 浮萍毁水面），
 *      失败原因只存在于聊天记录里，下一轮会重犯；
 *   ② prompt 是**判据的一部分**。改动 prompt 而不更新验收窗口，
 *      等于偷偷把及格线降了—— 而这正是本项目反复栽的「判据自己假绿」的前置步骤。
 *
 * ═══ 上一轮失败的两个原因（必须逐条规避，不是「注意一下」）═════════════
 *   ① **强制水印** —— 图生图服务会在画面角落盖 logo。
 *     规避：prompt 末尾的 negative 段显式要求无任何文字/水印，
 *     且**落图后必须人眼确认四角**（量具不会查这个）。
 *   ② **水面被塞满浮萍** —— 模型把「荷塘」理解成「浮萍塘」，
 *     画出来的绿点铺满水面，而画面中央必须是**干净的水**（鱼与倒影在那儿）。
 *     规避：negative 段点名 float / duckweed / algae，并把水面占比写死。
 *
 * ═══ 为什么用「图生图」而不是「文生图」══════════════════════════════════
 *   底图必须是**同一片荷塘**：水面形状、岸线走向、远处树木剪影都对得上，
 *   否则8s 交叉淡入会读成「镜头跳切」—— 这正是验收上限 16.0 要拦的东西。
 *   文生图必然重画构图 ⇒ 结构差会直接冲到 20 以上，等于必输。
 */

/**
 * 补图①：霜降（`autumn.png` 与 `winter.png` 之间的中间态）。
 *
 * ★★★ 一句话口径：**构图取冬、色取秋。**
 *   构图必须贴着 `winter.png`—— 因为超出它的那 22.40 结构差**正是要消掉的**；
 *   水色则应留在 `autumn.png` 那一侧，因为它要当霜降（frost .80 / ice .15）
 *   到立冬（frost 1.00 / ice .40）的起点。
 *   两端都贴 = 贴在原地 = 等于没补。**只贴一端**才是补图。
 *
 * 参考图用法（喂给 ImageGen 时按此顺序）：
 *   参考图1= winter.png  → 定构图（岸线、水面轮廓、远处树影、元素位置）
 *   参考图2 = autumn.png → 定色（水色、落叶残留的色调）
 * ⚠️ 若服务只支持单图参考，则**只给 winter.png**，并靠下面的文字描述给色 ——
 *   绝不能给 autumn.png 当唯一参考：那会落在 22 那一侧。
 */
export const PROMPT_SHUANGJIANG = {
  refs: ['public/assets/winter.png', 'public/assets/autumn.png'],
  prompt: [
    '江南荷塘的俯视全景，3840x2160，16:9 横向。',
    '构图严格沿用参考图（同一片荷塘）：水面轮廓、岸线走向、远处树木剪影、',
    '各元素的空间位置与占比，全部与参考图保持一致，不重新设计布局。',
    '',
    '季节：深秋将尽、冬意初降（霜降）。',
    '水色：保留秋季的暖褐与暗金 —— 水面仍有秋水的沉色，',
    '岸边尚有稀疏的枯荷残梗与少量落叶，',
    '但整体已不是纯粹的秋—— 草色开始发白，树木近乎光秃。',
    '',
    '水面必须大面积干净：中央与中景是开阔的明水，',
    '只有池心附近几片荷叶的残梗，水面本身不要被植物覆盖。',
    '',
    '整体色调偏冷灰绿，饱和度低，无强烈暖色块。',
  ].join('\n'),

  /**
   * 负面要求。⚠️ **不是**「写点形容词」——
   *   上一轮失败的诱因就是模型在画面里塞东西（水印/浮萍），
   *   所以负面项必须**逐个点名被禁止的对象**，而不是笼统说「干净」。
   */
  negative: [
    'no text, no watermark, no logo, no signature, no caption anywhere in the image',
    'no floating duckweed, no algae mats, no water hyacinth, no scum on the water',
    'no floating leaves covering the pond surface',
    'no ducks, no swans, no boats, no people, no buildings, no bridges',
    'no lotus flowers, no blooming lotus',
    'no ice sheet on the water',
    'no snow covering the ground',
    'no drastic layout change compared with the reference images',
    'no new large elements, no relocated shoreline',
  ].join(', '),

  /** 落图后必须立刻跑的两件事（prompt 文件自己写清，因为它们最容易被跳过） */
  verify: [
    '1) 量尺寸：必须 3840x2160 RGB（与现有 4 张一致），否则 uCover 的 16:9 假设不成立。',
    '2) 量结构差：python tools/measure-term-image.py compare public/assets/term-shuangjiang.png '
      + '--against public/assets/winter.png  ⇒ 必须落在 [8.0, 16.0]',
    '3) 量与 autumn 的差：同一命令 --against autumn.png ⇒ 也必须落在 [8.0, 16.0]',
    '⚠️ 3) 不能省：一张图只与「近邻」达标、离「远邻」冲到 20 以上，',
    '   等于把缺口从一侧挪到了另一侧 —— 这是最容易被放过的一种失败。',
    '4) 人眼看四角与水面中央：确认无水印、无浮萍。量具查不出这两项。',
  ],
};
