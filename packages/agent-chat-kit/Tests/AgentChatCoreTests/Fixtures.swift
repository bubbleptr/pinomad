/// Replies shaped like a coding agent's, covering the block structures whose
/// boundaries are easy to get wrong while streaming.
enum Fixtures {
    static let replies = lf + [
        lf[0].replacing("\n", with: "\r\n"),
        lf[0].replacing("\n", with: "\r"),
    ]

    private static let lf: [String] = [
        """
        # Fixing the flaky test

        The failure comes from a race between the **writer** and the `reader`:
        the reader can observe a half-written file.

        1. Write to a temporary file.
        2. Rename it into place.

           Rename is atomic on the same filesystem, so readers see the old
           file or the new one, never half of each.

        3. Fsync the directory.

        ```swift
        let tmp = url.appendingPathExtension("tmp")

        try data.write(to: tmp)
        try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        ```

        > Note: this does not help on network filesystems,
        where rename is not guaranteed to be atomic.

        | Case | Before | After |
        | --- | --- | --- |
        | local | flaky | stable |
        | NFS | flaky | flaky |

        - [x] reproduce
        - [ ] fix ~~everything~~ the race

        Summary
        -------

        That's all.
        """,
        """
        Two options:

        - keep the cache
          - pro: fast
          - con: stale reads

        - drop it

        ***

            indented code
            stays verbatim

        <details>
        <summary>Logs</summary>

        </details>

        Done, see [the docs](https://example.com/docs "Docs").
        """,
        #"""
        对任意向量 $x\in\mathbb R^n$，拉普拉斯二次型是：

        $$
        x^\top L x=\sum_{(i,j)\in E}(x_i-x_j)^2
        $$

        - $L$ 半正定，且 $L\mathbf 1=0$；花了 $5 和 $10。
        - 一行公式 $$\frac{\lambda_2}{2}\le h(G)$$ 也行，`$PATH$` 不是。

        \[
        \tau(G)=\det(L_{ii})
        \]

            echo $HOME/$USER

        见 [下载](https://example.com/$release$/file)，$n$ 个文件：

        > ```sh
        > echo $a$
        > ```
        """#,
    ]
}
