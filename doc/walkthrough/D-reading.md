# Appendix D — Further reading

If you want to go deeper on any of the threads this tutorial
introduced.

## Datalog theory

- **Abiteboul, Hull, and Vianu — *Foundations of Databases*
  (1995).** The standard reference for database theory. Chapter 12
  on Datalog and chapters 13–16 on negation, recursion, and
  expressive power are the definitive academic treatment. Freely
  available online at [webdam.inria.fr/Alice/](http://webdam.inria.fr/Alice/).
- **Ceri, Gottlob, Tanca — *What You Always Wanted To Know About
  Datalog (And Never Dared to Ask)*, IEEE TKDE 1989.** The classic
  survey paper. Short, opinionated, still the best 30-page
  introduction to the theoretical landscape.
- **Ullman — *Principles of Database and Knowledge-Base Systems*
  (1989).** Historical; Ullman was central to Datalog's original
  development.
- **Chen — *The Entity-Relationship Model* (1976).** Relevant for
  the correspondence between relational modelling and Horn clauses.

## Implementation

- **[Soufflé](https://souffle-lang.github.io/).** Industrial-scale
  Datalog compiler. Generates C++; used in production static
  analyses at Oracle, Amazon, and academic research groups. Has
  an excellent [tutorial](https://souffle-lang.github.io/tutorial)
  that covers many of the same examples as this tutorial, with a
  performance-oriented slant.
- **[LogicBlox](https://en.wikipedia.org/wiki/LogicBlox).**
  Commercial Datalog engine, no longer actively sold but
  historically important.
- **[Cozo](https://www.cozodb.org/).** Modern embedded Datalog
  database with additional features (vector search, indexing).
- **[Crepe](https://github.com/ekzhang/crepe).** Datalog as a Rust
  procedural macro — stunningly short implementation.
- **[DDlog](https://github.com/vmware/differential-datalog).**
  Differential Datalog: incremental computation on top of a
  Datalog engine; great for reactive / streaming use cases.

## Applied Datalog

- **[Doop](https://bitbucket.org/yanniss/doop/).** A
  whole-program pointer analysis framework for Java, implemented
  in ~5000 lines of Datalog. The reference for "serious Datalog
  for serious analysis".
- **Smaragdakis, Kastrinis, Bravenboer — *Pick Your Contexts Well:
  Understanding Object-Sensitivity*, POPL 2011.** Representative
  of Datalog-based pointer-analysis research.
- **Whaley, Avots, Carbin, Lam — *Using Datalog with Binary
  Decision Diagrams for Program Analysis*, APLAS 2005 (the
  "bddbddb" paper).** Classic Datalog-for-analysis paper; shows
  how to scale to whole-program analyses.

## Logic background

If the logic lens in this tutorial left you wanting more:

- **Barwise and Etchemendy — *Language, Proof, and Logic* (1999).**
  An unusually readable introduction to first-order logic. The
  Horn-clause and model-theoretic material in later chapters is
  directly relevant.
- **Lloyd — *Foundations of Logic Programming* (2nd ed., 1987).**
  The formal account of Horn-clause logic, SLD resolution, and
  negation-as-failure. Prolog-oriented but the foundations
  apply.
- **Clark — *Negation as Failure*, in *Logic and Databases*
  (1978).** The original paper on Clark completion — the
  formalisation of what closed-world negation means.
- **Van Gelder, Ross, Schlipf — *The Well-Founded Semantics for
  General Logic Programs* (JACM, 1991).** The three-valued
  semantics for programs that are not stratifiable, and the
  alternating fixed point that computes it. Chapter 17's
  parity-stratified fragment is the two-valued corner of this.

## Related languages

- **Prolog.** The obvious neighbour. Much more expressive
  (function symbols, cuts, arbitrary term structures) but loses
  termination and unique-model guarantees. Ivan Bratko's
  *Prolog Programming for Artificial Intelligence* is the
  standard textbook.
- **Mercury.** Statically-typed, purely-declarative logic
  programming. Closer to Datalog in the small, Prolog in the
  large.
- **Answer set programming (ASP).** Non-deterministic logic
  programming with stable-model semantics; handles cases that
  stratified Datalog rejects. Clingo is the canonical
  implementation.

## Community

- **[Datalog 2.0 workshop](https://datalog2.github.io/).**
  Biennial academic workshop on Datalog and its applications.
- **[Datalog subreddit](https://reddit.com/r/Datalog).** Small but
  active.
- **[Datalog paper archive](https://yanniss.github.io/datalog-paper.html).**
  Curated list of Datalog-adjacent papers, maintained by the
  Doop authors.
