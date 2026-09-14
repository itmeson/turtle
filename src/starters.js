/**
 * Example programs — SPEC.md section 15, decision 4.
 *
 * These exist so the first minute of a class is self-serve: a student who
 * opens the editor and does not know what to type has somewhere to start, and
 * a teacher does not have to dictate code while twenty-five people wait.
 *
 * Rules they all follow:
 *   - short enough to read in one screen
 *   - every one runs correctly as written
 *   - each introduces exactly one new idea beyond the previous
 *   - comments explain WHY, not what the line obviously does
 */

/** @typedef {{id: string, name: string, blurb: string, code: string}} Starter */

/** @type {Starter[]} */
export const STARTERS = [
  {
    id: 'square',
    name: 'A square',
    blurb: 'The smallest complete program: move and turn, four times.',
    code: `import turtle

t = turtle.Turtle()

# A square is the same two moves, four times over.
for side in range(4):
    t.forward(120)
    t.left(90)
`,
  },
  {
    id: 'spiral',
    name: 'Colourful spiral',
    blurb: 'A loop where the numbers change each time around.',
    code: `import turtle

t = turtle.Turtle()
t.speed(0)          # 0 means "draw it instantly"
t.pensize(2)

colours = ["red", "orange", "gold", "green", "blue", "purple"]

for i in range(120):
    # i counts 0, 1, 2 ... so the line gets longer every time.
    t.pencolor(colours[i % len(colours)])
    t.forward(i * 2)
    t.right(59)

t.hideturtle()
`,
  },
  {
    id: 'flower',
    name: 'Flower',
    blurb: 'A loop inside a loop — the idea most worth practising.',
    code: `import turtle

t = turtle.Turtle()
t.speed(0)
t.pencolor("purple")

# The outer loop draws 12 petals. The inner work is circle().
for petal in range(12):
    t.circle(80, 90)     # an arc: radius 80, a quarter turn
    t.left(90)
    t.circle(80, 90)
    t.left(90)
    t.left(30)           # turn a little before the next petal

t.hideturtle()
`,
  },
  {
    id: 'star',
    name: 'Filled star',
    blurb: 'Filling a shape, and why the angle is 144.',
    code: `import turtle

t = turtle.Turtle()
t.speed(3)
t.pencolor("darkgoldenrod")
t.fillcolor("gold")

# Everything drawn between begin_fill and end_fill gets filled in.
t.begin_fill()
for point in range(5):
    t.forward(200)
    t.right(144)      # 144 is what makes the lines cross into a star
t.end_fill()

t.hideturtle()
`,
  },
  {
    id: 'two-turtles',
    name: 'Two turtles',
    blurb: 'More than one turtle, each with its own pen and position.',
    code: `import turtle

red = turtle.Turtle()
blue = turtle.Turtle()

red.color("crimson")
blue.color("royalblue")

# Each turtle remembers its own position, heading and colour.
blue.penup()
blue.goto(0, -120)
blue.pendown()

for step in range(36):
    red.forward(20)
    red.left(10)
    blue.forward(20)
    blue.right(10)

red.hideturtle()
blue.hideturtle()
`,
  },
  {
    id: 'function',
    name: 'Your own function',
    blurb: 'Naming a piece of drawing so you can reuse it.',
    code: `import turtle

t = turtle.Turtle()
t.speed(0)

def polygon(pen, sides, size):
    """Draw any regular shape. The angles always add up to 360."""
    for side in range(sides):
        pen.forward(size)
        pen.left(360 / sides)

# Now the same three lines can draw anything.
for sides in range(3, 9):
    t.pencolor(["red", "orange", "green", "blue", "purple", "brown"][sides - 3])
    polygon(t, sides, 70)
    t.left(60)

t.hideturtle()
`,
  },
];

/** The program a brand-new student sees on their very first visit. */
export const FIRST_RUN = STARTERS[0].code;

/** @param {string} id */
export function starterById(id) {
  return STARTERS.find((s) => s.id === id) ?? null;
}
