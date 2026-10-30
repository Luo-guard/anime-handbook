"""Desktop command entry point. Business code lives in handbook/."""
import sys

if __name__ == "__main__":
    from handbook.desktop import main
    main(open_browser="--no-browser" not in sys.argv)
