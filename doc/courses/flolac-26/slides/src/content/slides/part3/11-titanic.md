---
title: "The Titanic dataset"
kind: content
section: "Statistics"
tight: true
---

Publicly available data about 891 passengers:

```prolog
input predicate passenger(id: integer,          # unique ID
                      survived: integer,    # 0: no, 1: yes
                      class: integer,       # 1-3 (first to third class)
                      sex: string,          # "male" or "female"
                      fare: float).         # how much they paid for their ticket
```

We don't know every passenger's age, so ages live in a separate relation:

```prolog
input predicate age(id: integer,                # refers to an id in passenger
                years: float).              # age at the time of the sinking (but check this later!)
```

<div class="note">
The next few summaries run live on the full dataset in the <a href="https://xiemaisi.github.io/datamog/#example=Titanic" target="_blank" rel="noopener">playground</a> — switch over there to demo them.
</div>

<p style="font-size: calc(var(--u) * 2.2); color: var(--muted)">Source: the <a href="https://www.kaggle.com/c/titanic" target="_blank" rel="noopener">Kaggle <em>Titanic</em></a> dataset.</p>
