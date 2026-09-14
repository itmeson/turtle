"""turtle -- browser implementation for the Python Turtle Editor.

This module shadows CPython's stdlib `turtle`, which cannot work here because
Pyodide ships no tkinter. Instead of drawing to a Tk canvas, every drawing
action appends an op to a display list that is flushed to JavaScript, where the
canvas renderer, the SVG exporter and the PNG exporter all consume the same
stream. See SPEC.md sections 5 and 6.

Scope for this version, agreed with the teacher:
  * drawing programs only -- no input(), no keyboard or mouse events
  * multiple turtles ARE supported
  * undo() is not implemented and says so clearly

Anything unsupported raises NotSupportedHere with an explanation of what to do
instead, never a bare AttributeError.

Coordinates in the op stream are turtle-space: origin at the centre, y upward.
Headings in the op stream are always degrees, standard orientation (0 = east,
counter-clockwise positive), regardless of degrees()/radians()/mode().
"""

import json
import math

from _turtle_bridge import emit

__all__ = [
    "Turtle", "RawTurtle", "Pen", "Screen", "TurtleScreen", "Vec2D",
    "TurtleGraphicsError", "NotSupportedHere",
    "forward", "fd", "backward", "bk", "back", "right", "rt", "left", "lt",
    "goto", "setpos", "setposition", "setx", "sety", "setheading", "seth",
    "home", "circle", "dot", "stamp", "clearstamp", "clearstamps", "speed",
    "position", "pos", "xcor", "ycor", "heading", "towards", "distance",
    "degrees", "radians",
    "pendown", "pd", "down", "penup", "pu", "up", "pensize", "width", "pen",
    "isdown", "color", "pencolor", "fillcolor", "filling", "begin_fill",
    "end_fill", "reset", "clear", "write", "hideturtle", "ht", "showturtle",
    "st", "isvisible", "shape", "shapesize", "turtlesize", "tilt",
    "settiltangle", "resizemode", "undo",
    "bgcolor", "screensize", "setworldcoordinates", "tracer", "update",
    "delay", "title", "mode", "colormode", "clearscreen", "resetscreen",
    "done", "mainloop", "exitonclick", "bye",
    "onkey", "onkeypress", "onkeyrelease", "onclick", "onrelease", "ondrag",
    "onscreenclick", "ontimer", "listen", "textinput", "numinput",
]


class TurtleGraphicsError(Exception):
    """Matches the stdlib exception, e.g. for a bad colour string."""


class NotSupportedHere(NotImplementedError):
    """Raised for turtle features this editor does not provide.

    The console renders this as an explanation rather than a crash, so the
    message should always tell the student what to do instead.
    """


# --------------------------------------------------------------------------
#  Colours
# --------------------------------------------------------------------------

_COLOR_NAMES = frozenset("""
aliceblue antiquewhite aqua aquamarine azure beige bisque black
blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkslategrey darkturquoise darkviolet
deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green
greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender
lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
lightyellow lime limegreen linen magenta maroon mediumaquamarine
mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
mistyrose moccasin navajowhite navy oldlace olive olivedrab orange
orangered orchid palegoldenrod palegreen paleturquoise palevioletred
papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell
sienna silver skyblue slateblue slategray slategrey snow springgreen
steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke
yellow yellowgreen
""".split())


def _check_color_name(name):
    low = name.strip().lower().replace(" ", "")
    if low in _COLOR_NAMES:
        return low
    # Tk also accepts grey0..grey100 / gray0..gray100.
    for prefix in ("gray", "grey"):
        if low.startswith(prefix) and low[len(prefix):].isdigit():
            n = int(low[len(prefix):])
            if 0 <= n <= 100:
                v = round(n * 255 / 100)
                return "#%02x%02x%02x" % (v, v, v)
    raise TurtleGraphicsError("bad color string: %s" % (name,))


def _color_to_css(value, colormode):
    """Accept every form turtle accepts and return something CSS understands."""
    if isinstance(value, str):
        s = value.strip()
        if s.startswith("#"):
            body = s[1:]
            if len(body) in (3, 6) and all(c in "0123456789abcdefABCDEF" for c in body):
                return s.lower()
            raise TurtleGraphicsError("bad color string: %s" % (value,))
        return _check_color_name(s)

    if isinstance(value, (tuple, list)):
        if len(value) != 3:
            raise TurtleGraphicsError("bad color arguments: %s" % (value,))
        scale = 255.0 / colormode
        out = []
        for component in value:
            n = int(round(component * scale))
            if n < 0 or n > 255:
                raise TurtleGraphicsError("bad color sequence: %s" % (value,))
            out.append(n)
        return "#%02x%02x%02x" % tuple(out)

    raise TurtleGraphicsError("bad color arguments: %s" % (value,))


# --------------------------------------------------------------------------
#  Vec2D -- same public behaviour as the stdlib class
# --------------------------------------------------------------------------

class Vec2D(tuple):
    def __new__(cls, x, y):
        return tuple.__new__(cls, (x, y))

    def __add__(self, other):
        return Vec2D(self[0] + other[0], self[1] + other[1])

    def __mul__(self, other):
        if isinstance(other, Vec2D):
            return self[0] * other[0] + self[1] * other[1]
        return Vec2D(self[0] * other, self[1] * other)

    def __rmul__(self, other):
        if isinstance(other, (int, float)):
            return Vec2D(self[0] * other, self[1] * other)
        return NotImplemented

    def __sub__(self, other):
        return Vec2D(self[0] - other[0], self[1] - other[1])

    def __neg__(self):
        return Vec2D(-self[0], -self[1])

    def __abs__(self):
        return math.hypot(self[0], self[1])

    def rotate(self, angle):
        perp = Vec2D(-self[1], self[0])
        angle = math.radians(angle)
        c, s = math.cos(angle), math.sin(angle)
        return Vec2D(self[0] * c + perp[0] * s, self[1] * c + perp[1] * s)

    def __getnewargs__(self):
        return (self[0], self[1])

    def __repr__(self):
        return "(%.2f,%.2f)" % self


# --------------------------------------------------------------------------
#  Screen
# --------------------------------------------------------------------------

# Flush when this many ops have accumulated. Small enough that the cursor does
# not lag far behind the drawing, large enough that postMessage overhead stays
# irrelevant on a spiral with tens of thousands of segments.
_BATCH = 128


class TurtleScreen:
    def __init__(self):
        self._turtles = []
        self._ops = []
        self._tracing = True
        self._delay = 10
        self._mode = "standard"
        self._colormode = 1.0
        self._bgcolor = "white"
        self._width = 600
        self._height = 600
        self._world = None
        self._stamp_seq = 0
        self._last_speed = 6
        self._title = "Python Turtle"

    # -- op plumbing ------------------------------------------------------

    def _add(self, op):
        self._ops.append(op)
        if self._tracing and len(self._ops) >= _BATCH:
            self._flush()

    def _flush(self, force=False):
        if not self._ops and not force:
            return
        payload = {
            "ops": self._ops,
            "turtles": [t._cursor() for t in self._turtles],
            "speed": self._last_speed,
            # tracer(0) means "do not animate"; the renderer draws such a batch
            # in one frame rather than pacing it.
            "tracing": self._tracing,
        }
        self._ops = []
        emit(json.dumps(payload))

    def _bounds(self):
        if self._world is not None:
            return self._world
        return (-self._width / 2.0, -self._height / 2.0,
                self._width / 2.0, self._height / 2.0)

    # -- public API -------------------------------------------------------

    def bgcolor(self, *args):
        if not args:
            return self._bgcolor
        value = args[0] if len(args) == 1 else args
        css = _color_to_css(value, self._colormode)
        self._bgcolor = value if len(args) == 1 else css
        self._add({"op": "bgcolor", "color": css})
        return None

    def screensize(self, canvwidth=None, canvheight=None, bg=None):
        if canvwidth is None and canvheight is None and bg is None:
            return (self._width, self._height)
        if canvwidth is not None:
            self._width = canvwidth
        if canvheight is not None:
            self._height = canvheight
        if bg is not None:
            self.bgcolor(bg)
        llx, lly, urx, ury = self._bounds()
        self._add({"op": "setworld", "llx": llx, "lly": lly, "urx": urx, "ury": ury})
        return None

    def setworldcoordinates(self, llx, lly, urx, ury):
        self._world = (llx, lly, urx, ury)
        self._mode = "world"
        self._add({"op": "setworld", "llx": llx, "lly": lly, "urx": urx, "ury": ury})

    def tracer(self, n=None, delay=None):
        if n is None:
            return 1 if self._tracing else 0
        self._tracing = bool(n)
        if delay is not None:
            self._delay = delay
        if self._tracing:
            self._flush()
        return None

    def update(self):
        self._flush(force=True)

    def delay(self, delay=None):
        if delay is None:
            return self._delay
        self._delay = delay
        return None

    def title(self, titlestring=None):
        if titlestring is None:
            return self._title
        self._title = titlestring
        return None

    def mode(self, mode=None):
        if mode is None:
            return self._mode
        mode = mode.lower()
        if mode not in ("standard", "logo", "world"):
            raise TurtleGraphicsError("No such mode: %s" % mode)
        self._mode = mode
        for t in self._turtles:
            t._set_mode(mode)
        return None

    def colormode(self, cmode=None):
        if cmode is None:
            return self._colormode
        if cmode not in (1.0, 1, 255):
            raise TurtleGraphicsError("No such colormode: %s" % cmode)
        self._colormode = float(cmode) if cmode != 255 else 255
        return None

    def clear(self):
        self._add({"op": "clear"})
        self._add({"op": "bgcolor", "color": _color_to_css(self._bgcolor, self._colormode)})

    clearscreen = clear

    def reset(self):
        self.clear()
        for t in self._turtles:
            t.reset()

    resetscreen = reset

    def turtles(self):
        return list(self._turtles)

    def window_width(self):
        return self._width

    def window_height(self):
        return self._height

    # -- deliberately unsupported ----------------------------------------

    def listen(self, *a, **k):
        raise NotSupportedHere(
            "listen() sets up keyboard input, which this editor doesn't support. "
            "It runs drawing programs -- ones that draw a picture and finish."
        )

    def onkey(self, *a, **k):
        raise NotSupportedHere(
            "onkey() needs keyboard input, which this editor doesn't support yet. "
            "It runs drawing programs -- ones that draw a picture and finish."
        )

    onkeypress = onkey
    onkeyrelease = onkey

    def onclick(self, *a, **k):
        raise NotSupportedHere(
            "onclick() needs mouse events, which this editor doesn't support yet. "
            "It runs drawing programs -- ones that draw a picture and finish."
        )

    onscreenclick = onclick

    def ontimer(self, *a, **k):
        raise NotSupportedHere(
            "ontimer() schedules code to run later, which this editor doesn't "
            "support yet. Try a for loop instead."
        )

    def textinput(self, *a, **k):
        raise NotSupportedHere(
            "textinput() asks the user to type something, which this editor "
            "doesn't support yet. Put the value directly in your program instead."
        )

    def numinput(self, *a, **k):
        raise NotSupportedHere(
            "numinput() asks the user to type a number, which this editor "
            "doesn't support yet. Put the number directly in your program instead."
        )

    def register_shape(self, name, shape=None):
        raise NotSupportedHere(
            "register_shape() adds custom turtle shapes, which this editor "
            "doesn't support yet. The built-in shapes are: arrow, turtle, "
            "circle, square, triangle, classic."
        )

    addshape = register_shape

    def getcanvas(self):
        raise NotSupportedHere(
            "getcanvas() exposes the underlying tkinter canvas, which does not "
            "exist in the browser."
        )

    # -- no-ops: students copy these from textbooks constantly ------------

    def mainloop(self):
        self._flush(force=True)

    done = mainloop

    def exitonclick(self):
        self._flush(force=True)

    def bye(self):
        self._flush(force=True)


_screen = TurtleScreen()

_VALID_SHAPES = ("classic", "arrow", "turtle", "circle", "square", "triangle", "blank")


# --------------------------------------------------------------------------
#  Turtle
# --------------------------------------------------------------------------

class RawTurtle:
    def __init__(self, canvas=None, shape="classic", undobuffersize=0, visible=True):
        self.screen = _screen
        self._reset_state(shape, visible)
        _screen._turtles.append(self)

    def _reset_state(self, shape="classic", visible=True):
        self._x = 0.0
        self._y = 0.0
        self._ox = 1.0          # orientation unit vector, standard orientation
        self._oy = 0.0
        self._down = True
        self._pencolor = "black"
        self._fillcolor = "black"
        self._pensize = 1
        self._visible = visible
        self._shape = shape
        self._stretch = (1.0, 1.0)
        self._outline = 1
        self._tilt = 0.0
        self._resizemode = "noresize"
        # CPython's default speed is not clearly documented; 6 ("normal") is a
        # deliberate classroom choice -- fast enough not to waste a period,
        # slow enough that students can watch the turtle work.
        self._speed = 6
        self._filling = False
        self._fillpath = []
        self._fullcircle = 360.0
        self._degreesPerAU = 1.0
        self._set_mode(_screen._mode)

    def _set_mode(self, mode):
        if mode == "logo":
            self._angleOffset = self._fullcircle / 4.0
            self._angleOrient = -1
        else:
            self._angleOffset = 0.0
            self._angleOrient = 1

    # -- internals --------------------------------------------------------

    def _cursor(self):
        return {
            "x": self._x, "y": self._y,
            "heading": math.degrees(math.atan2(self._oy, self._ox)) % 360.0,
            "visible": self._visible,
            "shape": self._shape,
            "fill": _color_to_css(self._fillcolor, self.screen._colormode),
            "pen": _color_to_css(self._pencolor, self.screen._colormode),
            "stretch": list(self._stretch),
            "outline": self._outline,
            "tilt": self._tilt,
        }

    def _rotate(self, angle):
        """angle is in the turtle's own angle units."""
        angle = angle * self._degreesPerAU
        v = Vec2D(self._ox, self._oy).rotate(angle)
        length = abs(v) or 1.0
        self._ox, self._oy = v[0] / length, v[1] / length

    def _goto(self, x, y):
        if self._down:
            self.screen._add({
                "op": "line",
                "x1": self._x, "y1": self._y, "x2": x, "y2": y,
                "color": _color_to_css(self._pencolor, self.screen._colormode),
                "width": self._pensize,
            })
        self._x = x
        self._y = y
        if self._filling:
            self._fillpath.append([x, y])
        self.screen._last_speed = self._speed

    def _go(self, distance):
        self._goto(self._x + self._ox * distance, self._y + self._oy * distance)

    # -- motion -----------------------------------------------------------

    def forward(self, distance):
        self._go(distance)

    fd = forward

    def backward(self, distance):
        self._go(-distance)

    bk = backward
    back = backward

    def right(self, angle):
        self._rotate(-angle)

    rt = right

    def left(self, angle):
        self._rotate(angle)

    lt = left

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self._goto(x, y)

    setpos = goto
    setposition = goto

    def setx(self, x):
        self._goto(x, self._y)

    def sety(self, y):
        self._goto(self._x, y)

    def home(self):
        self.goto(0, 0)
        self.setheading(0)

    def setheading(self, to_angle):
        angle = (to_angle - self.heading()) * self._angleOrient
        full = self._fullcircle
        angle = (angle + full / 2.0) % full - full / 2.0
        self._rotate(angle)

    seth = setheading

    def circle(self, radius, extent=None, steps=None):
        # Same subdivision rule as CPython, so a circle here has the same
        # number of segments -- and the same look -- as one on the desktop.
        if extent is None:
            extent = self._fullcircle
        if steps is None:
            frac = abs(extent) / self._fullcircle
            steps = 1 + int(min(11 + abs(radius) / 6.0, 59.0) * frac)
        w = 1.0 * extent / steps
        w2 = 0.5 * w
        length = 2.0 * radius * math.sin(w2 * math.pi / 180.0 * self._degreesPerAU)
        if radius < 0:
            length, w, w2 = -length, -w, -w2
        self._rotate(w2)
        for _ in range(steps):
            self._go(length)
            self._rotate(w)
        self._rotate(-w2)

    def dot(self, size=None, *color):
        if not color:
            css = _color_to_css(self._pencolor, self.screen._colormode)
        else:
            value = color[0] if len(color) == 1 else color
            css = _color_to_css(value, self.screen._colormode)
        if size is None:
            size = max(self._pensize + 4, 2 * self._pensize)
        self.screen._add({"op": "dot", "x": self._x, "y": self._y, "d": size, "color": css})

    def stamp(self):
        self.screen._stamp_seq += 1
        stamp_id = self.screen._stamp_seq
        state = self._cursor()
        self.screen._add({
            "op": "stamp", "id": stamp_id,
            "x": state["x"], "y": state["y"], "heading": state["heading"],
            "shape": state["shape"], "fill": state["fill"], "pen": state["pen"],
            "stretch": state["stretch"], "outline": state["outline"],
            "tilt": state["tilt"],
        })
        self._stamps = getattr(self, "_stamps", [])
        self._stamps.append(stamp_id)
        return stamp_id

    def clearstamp(self, stampid):
        self.screen._add({"op": "clearstamp", "id": stampid})
        if stampid in getattr(self, "_stamps", []):
            self._stamps.remove(stampid)

    def clearstamps(self, n=None):
        stamps = getattr(self, "_stamps", [])
        if n is None:
            doomed = list(stamps)
        elif n >= 0:
            doomed = stamps[:n]
        else:
            doomed = stamps[n:]
        for s in doomed:
            self.clearstamp(s)

    def speed(self, speed=None):
        names = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}
        if speed is None:
            return self._speed
        if isinstance(speed, str):
            speed = names.get(speed.lower())
            if speed is None:
                raise TurtleGraphicsError("bad speed string")
        speed = int(speed)
        if speed < 0 or speed > 10:
            speed = 0 if speed > 10 else 10
        self._speed = speed
        self.screen._last_speed = speed
        return None

    # -- state queries ----------------------------------------------------

    def position(self):
        return Vec2D(self._x, self._y)

    pos = position

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def heading(self):
        deg = round(math.degrees(math.atan2(self._oy, self._ox)), 10) % 360.0
        result = deg / self._degreesPerAU
        return (self._angleOffset + self._angleOrient * result) % self._fullcircle

    def towards(self, x, y=None):
        if y is None:
            x, y = x
        deg = round(math.degrees(math.atan2(y - self._y, x - self._x)), 10) % 360.0
        result = deg / self._degreesPerAU
        return (self._angleOffset + self._angleOrient * result) % self._fullcircle

    def distance(self, x, y=None):
        if y is None:
            if hasattr(x, "position"):
                x, y = x.position()
            else:
                x, y = x
        return math.hypot(x - self._x, y - self._y)

    def degrees(self, fullcircle=360.0):
        self._fullcircle = float(fullcircle)
        self._degreesPerAU = 360.0 / self._fullcircle
        self._set_mode(self.screen._mode)

    def radians(self):
        self.degrees(2.0 * math.pi)

    # -- pen --------------------------------------------------------------

    def pendown(self):
        self._down = True

    pd = pendown
    down = pendown

    def penup(self):
        self._down = False

    pu = penup
    up = penup

    def isdown(self):
        return self._down

    def pensize(self, width=None):
        if width is None:
            return self._pensize
        self._pensize = width
        return None

    width = pensize

    def pen(self, pen=None, **pendict):
        state = {
            "shown": self._visible, "pendown": self._down,
            "pencolor": self._pencolor, "fillcolor": self._fillcolor,
            "pensize": self._pensize, "speed": self._speed,
            "resizemode": self._resizemode, "stretchfactor": self._stretch,
            "outline": self._outline, "tilt": self._tilt,
        }
        if pen is None and not pendict:
            return state
        merged = {}
        if pen:
            merged.update(pen)
        merged.update(pendict)
        if "pendown" in merged:
            self._down = merged["pendown"]
        if "shown" in merged:
            self._visible = merged["shown"]
        if "pencolor" in merged:
            self.pencolor(merged["pencolor"])
        if "fillcolor" in merged:
            self.fillcolor(merged["fillcolor"])
        if "pensize" in merged:
            self._pensize = merged["pensize"]
        if "speed" in merged:
            self.speed(merged["speed"])
        if "resizemode" in merged:
            self._resizemode = merged["resizemode"]
        if "stretchfactor" in merged:
            sf = merged["stretchfactor"]
            self._stretch = (sf, sf) if isinstance(sf, (int, float)) else tuple(sf)
        if "outline" in merged:
            self._outline = merged["outline"]
        if "tilt" in merged:
            self._tilt = merged["tilt"]
        return None

    # -- colour -----------------------------------------------------------

    def pencolor(self, *args):
        if not args:
            return self._pencolor
        value = args[0] if len(args) == 1 else args
        _color_to_css(value, self.screen._colormode)   # validate now, not at draw time
        self._pencolor = value
        return None

    def fillcolor(self, *args):
        if not args:
            return self._fillcolor
        value = args[0] if len(args) == 1 else args
        _color_to_css(value, self.screen._colormode)
        self._fillcolor = value
        return None

    def color(self, *args):
        if not args:
            return (self._pencolor, self._fillcolor)
        if len(args) == 1:
            self.pencolor(args[0])
            self.fillcolor(args[0])
        elif len(args) == 2:
            self.pencolor(args[0])
            self.fillcolor(args[1])
        elif len(args) == 3:
            self.pencolor(args)
            self.fillcolor(args)
        return None

    # -- filling ----------------------------------------------------------

    def begin_fill(self):
        self._filling = True
        self._fillpath = [[self._x, self._y]]

    def end_fill(self):
        if self._filling and len(self._fillpath) > 2:
            self.screen._add({
                "op": "poly",
                "pts": self._fillpath,
                "fill": _color_to_css(self._fillcolor, self.screen._colormode),
            })
        self._filling = False
        self._fillpath = []

    def filling(self):
        return self._filling

    # -- appearance -------------------------------------------------------

    def hideturtle(self):
        self._visible = False

    ht = hideturtle

    def showturtle(self):
        self._visible = True

    st = showturtle

    def isvisible(self):
        return self._visible

    def shape(self, name=None):
        if name is None:
            return self._shape
        if name not in _VALID_SHAPES:
            raise TurtleGraphicsError(
                "There is no shape named %s. Available shapes: %s"
                % (name, ", ".join(_VALID_SHAPES))
            )
        self._shape = name
        return None

    def shapesize(self, stretch_wid=None, stretch_len=None, outline=None):
        if stretch_wid is None and stretch_len is None and outline is None:
            return (self._stretch[0], self._stretch[1], self._outline)
        if stretch_wid is not None and stretch_len is None:
            stretch_len = stretch_wid
        if stretch_wid is not None:
            self._stretch = (stretch_wid, stretch_len)
        if outline is not None:
            self._outline = outline
        self._resizemode = "user"
        return None

    turtlesize = shapesize

    def resizemode(self, rmode=None):
        if rmode is None:
            return self._resizemode
        rmode = rmode.lower()
        if rmode in ("auto", "user", "noresize"):
            self._resizemode = rmode
        return None

    def tilt(self, angle):
        self._tilt = (self._tilt + angle * self._degreesPerAU) % 360.0
        self._resizemode = "user"

    def settiltangle(self, angle):
        self._tilt = (angle * self._degreesPerAU) % 360.0
        self._resizemode = "user"

    def tiltangle(self, angle=None):
        if angle is None:
            return self._tilt / self._degreesPerAU
        self.settiltangle(angle)
        return None

    # -- text -------------------------------------------------------------

    def write(self, arg, move=False, align="left", font=("Arial", 8, "normal")):
        text = str(arg)
        family, size, style = (list(font) + ["normal"])[:3] if font else ("Arial", 8, "normal")
        self.screen._add({
            "op": "text", "x": self._x, "y": self._y, "s": text,
            "font": [family, size, style], "align": align,
            "color": _color_to_css(self._pencolor, self.screen._colormode),
        })
        if move:
            # Real turtle measures the rendered text. We cannot from Python, so
            # this is an estimate; it is only used to advance the pen.
            self._goto(self._x + 0.6 * size * len(text), self._y)

    # -- reset ------------------------------------------------------------

    def reset(self):
        was_visible = self._visible
        self._reset_state(self._shape, was_visible)
        self.screen._add({"op": "clear"})

    def clear(self):
        self.screen._add({"op": "clear"})

    # -- unsupported ------------------------------------------------------

    def undo(self):
        raise NotSupportedHere(
            "undo() is not available in this editor. To take a step back, "
            "change your program and run it again."
        )

    def onclick(self, *a, **k):
        raise NotSupportedHere(
            "onclick() needs mouse events, which this editor doesn't support yet. "
            "It runs drawing programs -- ones that draw a picture and finish."
        )

    onrelease = onclick
    ondrag = onclick

    def getscreen(self):
        return self.screen

    def getturtle(self):
        return self

    getpen = getturtle


class Turtle(RawTurtle):
    """The turtle class students actually use."""


Pen = Turtle


def Screen():
    return _screen


# --------------------------------------------------------------------------
#  Module-level functions, delegating to a lazily created default turtle
# --------------------------------------------------------------------------

_default = None


def _turtle():
    global _default
    if _default is None:
        _default = Turtle()
    return _default


def _make_turtle_delegate(name):
    def delegate(*args, **kwargs):
        return getattr(_turtle(), name)(*args, **kwargs)
    delegate.__name__ = name
    return delegate


def _make_screen_delegate(name):
    def delegate(*args, **kwargs):
        return getattr(_screen, name)(*args, **kwargs)
    delegate.__name__ = name
    return delegate


_TURTLE_METHODS = [
    "forward", "fd", "backward", "bk", "back", "right", "rt", "left", "lt",
    "goto", "setpos", "setposition", "setx", "sety", "setheading", "seth",
    "home", "circle", "dot", "stamp", "clearstamp", "clearstamps", "speed",
    "position", "pos", "xcor", "ycor", "heading", "towards", "distance",
    "degrees", "radians", "pendown", "pd", "down", "penup", "pu", "up",
    "pensize", "width", "pen", "isdown", "color", "pencolor", "fillcolor",
    "filling", "begin_fill", "end_fill", "write", "hideturtle", "ht",
    "showturtle", "st", "isvisible", "shape", "shapesize", "turtlesize",
    "tilt", "settiltangle", "tiltangle", "resizemode", "undo", "getscreen",
    "getturtle", "getpen", "onclick", "onrelease", "ondrag",
]

_SCREEN_METHODS = [
    "bgcolor", "screensize", "setworldcoordinates", "tracer", "update",
    "delay", "title", "mode", "colormode", "clearscreen", "resetscreen",
    "done", "mainloop", "exitonclick", "bye", "listen", "onkey", "onkeypress",
    "onkeyrelease", "onscreenclick", "ontimer", "textinput", "numinput",
    "register_shape", "addshape", "getcanvas", "turtles", "window_width",
    "window_height",
]

for _name in _TURTLE_METHODS:
    globals()[_name] = _make_turtle_delegate(_name)

for _name in _SCREEN_METHODS:
    globals()[_name] = _make_screen_delegate(_name)


def reset():
    _turtle().reset()


def clear():
    _turtle().clear()


del _name


# --------------------------------------------------------------------------
#  Editor integration -- not part of the turtle API
# --------------------------------------------------------------------------

def _editor_configure(width, height):
    """Called by the worker before each run, with the canvas size in pixels."""
    global _default
    _screen.__init__()
    _screen._width = width
    _screen._height = height
    _default = None


def _editor_finish():
    """Called by the worker after each run: draw whatever is still buffered."""
    _screen._flush(force=True)
