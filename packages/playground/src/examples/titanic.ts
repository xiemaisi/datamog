// `gh:OWNER/REPO/PATH` shorthand for the pandas raw CSV — the playground's
// CSV-URL loader expands it to https://raw.githubusercontent.com/.../HEAD/...
// just like the CLI's `--input` does.
export const TITANIC_CSV_URL = "gh:pandas-dev/pandas/doc/data/titanic.csv";

export const titanicExample = {
  name: "Titanic",
  description: "Survival summaries over the pandas Titanic CSV, loaded from GitHub raw",
  source: `# Titanic survival summaries.
#
# The passenger table is loaded from pandas' CORS-enabled raw GitHub CSV
# via the gh: shorthand (gh:pandas-dev/pandas/doc/data/titanic.csv).

input predicate passenger(
    PassengerId: integer,
    Survived: integer,
    Pclass: integer,
    Name: string,
    Sex: string,
    Age: float?,
    SibSp: integer,
    Parch: integer,
    Ticket: string,
    Fare: float,
    Cabin: string?,
    Embarked: string?
).

output predicate survival_by_sex(Sex, avg(Survived), count(*)) :-
    passenger(_, Survived, _, _, Sex, _, _, _, _, _, _, _).

output predicate survival_by_class(Class, avg(Survived), count(*)) :-
    passenger(_, Survived, Class, _, _, _, _, _, _, _, _, _).

output predicate fare_by_class(Class, avg(Fare)) :-
    passenger(_, _, Class, _, _, _, _, _, _, Fare, _, _).

# Age is declared float?, and averaging needs a value, so the guard says which
# ages count. That is what "known age" meant anyway.
output predicate known_age_by_survival(Survived, avg(Age), count(Age)) :-
    passenger(_, Survived, _, _, _, Age, _, _, _, _, _, _), Age <> null.
`,
  csvUrlData: {
    passenger: TITANIC_CSV_URL,
  },
};
