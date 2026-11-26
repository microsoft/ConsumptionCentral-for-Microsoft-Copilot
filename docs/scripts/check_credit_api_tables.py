"""Check shipped optional Graph credit tables using their source-of-truth repair."""
from fix_credit_api_tables import main

if __name__ == "__main__":
    raise SystemExit(main(["--check"]))
