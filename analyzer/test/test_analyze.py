"""The analyzer's own checks Run: python3 -m unittest discover analyzer/test"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import analyze  # noqa: E402  (Slither itself is imported only when an analysis runs)


class SafePath(unittest.TestCase):
    def test_a_source_is_kept_under_its_own_name(self):
        for p in ["src/Vault.sol", "@openzeppelin/contracts/token/ERC20/ERC20.sol", "Vault.sol", "contracts/lib/a.b.sol"]:
            self.assertEqual(analyze.safe_path(p), p)

    def test_nothing_is_written_outside_the_work_directory(self):
        for p in ["../x.sol", "src/../../x.sol", "/etc/passwd", "C:/x.sol", "c:\\x.sol", "..\\x.sol",
                  "a//b.sol", "", "a\0b.sol", "x" * 401]:
            self.assertIsNone(analyze.safe_path(p), repr(p))


class Version(unittest.TestCase):
    def test_only_a_released_solc_version(self):
        for v in ["0.8.24", "0.4.26"]:
            self.assertTrue(analyze.VERSION.match(v))
        for v in ["0.8", "latest", "0.8.24; rm -rf /", "v0.8.24", "0.8.24-nightly"]:
            self.assertFalse(analyze.VERSION.match(v), v)


if __name__ == "__main__":
    unittest.main()
