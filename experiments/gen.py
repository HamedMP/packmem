# Deterministic synthetic web-access-log generator (JSONL). Zipf-ish users/paths, realistic fields.
import json, random, sys
random.seed(42)
N = int(sys.argv[1]); out = sys.argv[2]
uas = ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%d.0.0.0 Safari/537.36" % v for v in range(118,131)] + \
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/%d.0 Safari/605.1.15" % v for v in range(15,19)] + \
      ["curl/8.%d.0" % v for v in range(0,9)] + ["python-requests/2.%d.0" % v for v in range(28,33)] + ["Googlebot/2.1 (+http://www.google.com/bot.html)"]
sections = ["products","users","orders","api/v1/items","api/v1/search","static/js","static/css","blog","docs/guide","cart"]
methods = ["GET"]*8 + ["POST"]*2 + ["PUT","DELETE"]
statuses = [200]*85 + [304]*6 + [404]*5 + [301]*2 + [500,502]
countries = ["SE","US","DE","GB","FR","NL","IN","BR","JP","CA"]
def zipf(n, a=1.2):
    while True:
        v = int(random.paretovariate(a))
        if v <= n: return v
ts = 1760000000000
with open(out,"w") as f:
    for i in range(N):
        ts += random.choice([0,0,1,1,2,3,5,8,13,40])
        s = random.choice(sections)
        path = "/%s/%d" % (s, zipf(50000)) if not s.startswith("static") else "/%s/chunk-%04x.min.%s" % (s, zipf(300), s[-2:] if s.endswith("js") else "css")
        st = random.choice(statuses)
        rec = {"ts": ts, "user_id": zipf(100000), "method": random.choice(methods), "path": path, "status": st,
               "bytes": 0 if st==304 else int(random.lognormvariate(8,1.5)), "latency_us": int(random.lognormvariate(9,1)),
               "ip": "10.%d.%d.%d" % (zipf(20), random.randint(0,255), random.randint(1,254)),
               "country": random.choice(countries), "ua": random.choice(uas), "session": "%016x" % random.getrandbits(64)}
        f.write(json.dumps(rec, separators=(",",":"))+"\n")
