"""Jednoducha sbernice udalosti pro zive aktualizace v prohlizeci (SSE)."""
import asyncio
import threading


class EventBus:
    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()
        self.loop = None

    def subscribe(self):
        queue = asyncio.Queue(maxsize=200)
        with self._lock:
            self._subs.add(queue)
        return queue

    def unsubscribe(self, queue):
        with self._lock:
            self._subs.discard(queue)

    def publish(self, event):
        """Lze volat z libovolneho vlakna."""
        loop = self.loop
        if loop is None:
            return
        with self._lock:
            subs = list(self._subs)

        def put():
            for q in subs:
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass

        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:
            pass


bus = EventBus()
