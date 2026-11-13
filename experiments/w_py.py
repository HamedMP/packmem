import json,sys,time
recs=[json.loads(l) for l in open(sys.argv[1])]
print("ready",flush=True); time.sleep(600)
