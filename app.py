"""Desktop command entry point. Business code lives in handbook/."""
import sys

if __name__ == "__main__":
    from handbook.desktop import main, should_open_browser
    # 临时数据目录（测试、截图、排障副本）默认不开浏览器，避免窗口抢焦点；
    # 正常双击启动走 launch_handbook.ps1，不会设置该变量，因此照常打开。
    main(open_browser=should_open_browser())
