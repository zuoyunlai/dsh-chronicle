/**
 * 串行化器：把任意异步任务排成一条队，任何时刻只跑一个。
 *
 * 为什么需要：落盘有四个触发点（启动、session/flush、定时器、攒够阈值），
 * 并发 flush 会在 `pending.delete(day)` 之前各自读到同一批行 ⇒ 写出重复行。
 * 一个 6 行的队列比引入锁库划算得多，且行为可测。
 */
export function createSerializer() {
  let chain = Promise.resolve()

  /** @param {() => Promise<any>} task */
  function run(task) {
    const next = chain.then(() => task())
    // 失败不能卡死队列：吞掉错误继续排下一件，但把错误交回调用方
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return run
}
