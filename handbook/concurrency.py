"""Small writer-preferring read/write gate for connection and account lifetimes."""
from contextlib import contextmanager
import threading


class ReadWriteGate:
    def __init__(self):
        self._condition = threading.Condition(threading.RLock())
        self._readers = {}
        self._writer = None
        self._depth = 0
        self._waiting = 0

    @contextmanager
    def read(self):
        owner = threading.get_ident()
        with self._condition:
            while self._writer not in (None, owner) or (self._waiting and owner not in self._readers and self._writer != owner):
                self._condition.wait()
            self._readers[owner] = self._readers.get(owner, 0) + 1
        try:
            yield
        finally:
            with self._condition:
                self._readers[owner] -= 1
                if not self._readers[owner]: del self._readers[owner]
                self._condition.notify_all()

    @contextmanager
    def write(self):
        owner = threading.get_ident()
        with self._condition:
            if owner in self._readers and self._writer != owner:
                raise RuntimeError("Cannot upgrade a live reader to a writer")
            self._waiting += 1
            try:
                while self._writer not in (None, owner) or self._readers:
                    # Nested writes may contain reads owned by this same writer.
                    if self._writer == owner: break
                    self._condition.wait()
                self._writer = owner
                self._depth += 1
            finally:
                self._waiting -= 1
        try:
            yield
        finally:
            with self._condition:
                self._depth -= 1
                if not self._depth: self._writer = None
                self._condition.notify_all()


# Different service instances for the same SQLite file must share lifetimes too.
import os
import weakref


class DatabaseState:
    def __init__(self):
        self.write_lock = threading.RLock()
        self.gate = ReadWriteGate()
        self.revision_lock = threading.Lock()
        self.revision = 1


_states = weakref.WeakValueDictionary()
_states_lock = threading.Lock()


def database_state(path):
    key = os.path.normcase(str(path.resolve()))
    with _states_lock:
        state = _states.get(key)
        if state is None:
            state = DatabaseState()
            _states[key] = state
        return state
