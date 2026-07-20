package expo.modules.t3terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import androidx.core.widget.doAfterTextChanged
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.t3terminal.vt.FocusedTerminalEmulator
import expo.modules.t3terminal.vt.TerminalCell
import kotlin.math.floor
import kotlin.math.max

class T3TerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()
  private val emulator = FocusedTerminalEmulator()
  private val terminalView = TerminalCanvasView(context, emulator)
  private val inputView = EditText(context)
  private var clearingInput = false
  private var lastAppliedBuffer = ""
  private var lastReportedCols = 0
  private var lastReportedRows = 0
  private var backgroundColorValue = Color.parseColor("#24292E")
  private var foregroundColorValue = Color.parseColor("#D1D5DA")
  private var mutedForegroundColorValue = Color.parseColor("#959DA5")

  var terminalKey: String = ""
    set(value) {
      if (field == value) return
      field = value
      contentDescription = "t3-terminal-$value"
      resetAndReplay()
    }

  var initialBuffer: String = ""
    set(value) {
      field = value
      applyRemoteBuffer(value)
    }

  var fontSize: Float = 10f
    set(value) {
      field = value.coerceAtLeast(4f)
      terminalView.fontSizeSp = field
      inputView.textSize = max(field, 13f)
      recalculateGrid()
    }

  var appearanceScheme: String = "dark"
    set(value) {
      field = value
    }

  var themeConfig: String = ""

  var focusRequest: Double = 0.0
    set(value) {
      val previous = field
      field = value
      if (value != previous && value > 0) {
        requestKeyboardFocus()
      }
    }

  var autoFocus: Boolean = true
    set(value) {
      field = value
      if (value) {
        requestKeyboardFocus()
      } else {
        inputView.clearFocus()
        hideKeyboard()
      }
    }

  var backgroundColorHex: String = "#24292E"
    set(value) {
      field = value
      backgroundColorValue = parseColor(value, backgroundColorValue)
      applyTheme()
    }

  var foregroundColorHex: String = "#D1D5DA"
    set(value) {
      field = value
      foregroundColorValue = parseColor(value, foregroundColorValue)
      applyTheme()
    }

  var mutedForegroundColorHex: String = "#959DA5"
    set(value) {
      field = value
      mutedForegroundColorValue = parseColor(value, mutedForegroundColorValue)
      applyTheme()
    }

  init {
    isClickable = true
    isFocusable = true
    applyTheme()

    terminalView.layoutParams = LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    )
    terminalView.onGridChanged = { cols, rows -> resizeTerminal(cols, rows) }
    terminalView.setOnClickListener { requestKeyboardFocus() }

    inputView.layoutParams = FrameLayout.LayoutParams(1, 1)
    inputView.setTextColor(Color.TRANSPARENT)
    inputView.setHintTextColor(Color.TRANSPARENT)
    inputView.setBackgroundColor(Color.TRANSPARENT)
    inputView.typeface = Typeface.MONOSPACE
    inputView.textSize = max(fontSize, 13f)
    inputView.alpha = 0.02f
    inputView.imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    inputView.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    inputView.setPadding(0, 0, 0, 0)
    inputView.setOnFocusChangeListener { _, hasFocus ->
      terminalView.hasTerminalFocus = hasFocus
      if (hasFocus) showKeyboard()
    }
    inputView.setOnEditorActionListener { _, actionId, event ->
      val isEnterKey = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
      if (actionId != EditorInfo.IME_ACTION_SEND && !isEnterKey) return@setOnEditorActionListener false
      onInput(mapOf("data" to "\n"))
      true
    }
    inputView.setOnKeyListener { _, keyCode, event ->
      if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
      when {
        keyCode == KeyEvent.KEYCODE_DEL -> {
          onInput(mapOf("data" to "\u007F"))
          true
        }
        event.isCtrlPressed && keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> {
          onInput(mapOf("data" to (keyCode - KeyEvent.KEYCODE_A + 1).toChar().toString()))
          true
        }
        else -> false
      }
    }
    inputView.doAfterTextChanged { editable ->
      if (clearingInput) return@doAfterTextChanged
      val text = editable?.toString().orEmpty()
      if (text.isEmpty()) return@doAfterTextChanged
      onInput(mapOf("data" to text))
      clearingInput = true
      inputView.text?.clear()
      clearingInput = false
    }

    addView(terminalView)
    addView(inputView)
    setOnClickListener { requestKeyboardFocus() }

    post { requestKeyboardFocus() }
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    recalculateGrid()
  }

  private fun applyRemoteBuffer(buffer: String) {
    if (buffer.startsWith(lastAppliedBuffer)) {
      val suffix = buffer.substring(lastAppliedBuffer.length)
      if (suffix.isNotEmpty()) {
        emulator.feed(suffix)
        terminalView.invalidate()
      }
      lastAppliedBuffer = buffer
      return
    }

    resetAndReplay()
  }

  private fun resetAndReplay() {
    emulator.reset()
    lastAppliedBuffer = ""
    if (initialBuffer.isNotEmpty()) {
      emulator.feed(initialBuffer)
      lastAppliedBuffer = initialBuffer
    }
    terminalView.invalidate()
  }

  private fun recalculateGrid() {
    terminalView.recalculateGrid()
  }

  private fun resizeTerminal(cols: Int, rows: Int) {
    emulator.resize(cols, rows)
    terminalView.invalidate()
    if (cols == lastReportedCols && rows == lastReportedRows) return
    lastReportedCols = cols
    lastReportedRows = rows
    onResize(mapOf("cols" to cols, "rows" to rows))
  }

  private fun requestKeyboardFocus() {
    inputView.requestFocus()
    showKeyboard()
  }

  private fun hideKeyboard() {
    val inputMethodManager = context.getSystemService(
      Context.INPUT_METHOD_SERVICE
    ) as? InputMethodManager
    inputMethodManager?.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun applyTheme() {
    setBackgroundColor(backgroundColorValue)
    terminalView.backgroundColorValue = backgroundColorValue
    terminalView.foregroundColorValue = foregroundColorValue
    terminalView.mutedForegroundColorValue = mutedForegroundColorValue
    inputView.setTextColor(Color.TRANSPARENT)
    inputView.setHintTextColor(mutedForegroundColorValue)
    inputView.setBackgroundColor(Color.TRANSPARENT)
    terminalView.invalidate()
  }

  private fun parseColor(value: String, fallback: Int): Int =
    try {
      Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      fallback
    }

  private fun showKeyboard() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(inputView, InputMethodManager.SHOW_IMPLICIT)
  }
}

private class TerminalCanvasView(
  context: Context,
  private val emulator: FocusedTerminalEmulator,
) : View(context) {
  private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
  private val backgroundPaint = Paint()
  private val cursorPaint = Paint()
  private var cellWidth = 1f
  private var cellHeight = 1f
  private var baselineOffset = 0f
  private var measuredCols = 80
  private var measuredRows = 24

  var onGridChanged: ((cols: Int, rows: Int) -> Unit)? = null
  var backgroundColorValue: Int = Color.parseColor("#24292E")
    set(value) {
      field = value
      setBackgroundColor(value)
    }
  var foregroundColorValue: Int = Color.parseColor("#D1D5DA")
  var mutedForegroundColorValue: Int = Color.parseColor("#959DA5")
  var hasTerminalFocus: Boolean = false
    set(value) {
      field = value
      invalidate()
    }
  var fontSizeSp: Float = 10f
    set(value) {
      field = value.coerceAtLeast(4f)
      configurePaint()
      recalculateGrid()
      invalidate()
    }

  init {
    isClickable = true
    isFocusable = false
    textPaint.typeface = Typeface.MONOSPACE
    configurePaint()
    setBackgroundColor(backgroundColorValue)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_UP) performClick()
    return true
  }

  override fun performClick(): Boolean {
    super.performClick()
    return true
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    recalculateGrid()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val snapshot = emulator.snapshot()
    canvas.drawColor(backgroundColorValue)

    for (row in 0 until snapshot.rows) {
      val y = row * cellHeight
      val line = snapshot.cells[row]
      for (col in 0 until snapshot.cols) {
        val cell = line[col]
        drawCellBackground(canvas, cell, col, y)
      }
      for (col in 0 until snapshot.cols) {
        val cell = line[col]
        if (cell.codePoint == 32) continue
        drawCellText(canvas, cell, col, y)
      }
    }

    if (snapshot.showCursor && hasTerminalFocus) {
      cursorPaint.color = mutedForegroundColorValue
      cursorPaint.style = Paint.Style.STROKE
      cursorPaint.strokeWidth = max(1f, resources.displayMetrics.density)
      val left = snapshot.cursorCol * cellWidth
      val top = snapshot.cursorRow * cellHeight
      canvas.drawRect(RectF(left, top, left + cellWidth, top + cellHeight), cursorPaint)
    }
  }

  fun recalculateGrid() {
    if (width <= 0 || height <= 0) return
    configurePaint()
    val nextCols = max(1, floor(width / cellWidth).toInt())
    val nextRows = max(1, floor(height / cellHeight).toInt())
    if (nextCols == measuredCols && nextRows == measuredRows) return
    measuredCols = nextCols
    measuredRows = nextRows
    onGridChanged?.invoke(nextCols, nextRows)
  }

  private fun configurePaint() {
    textPaint.textSize = fontSizeSp * resources.displayMetrics.scaledDensity
    textPaint.typeface = Typeface.MONOSPACE
    val metrics = textPaint.fontMetrics
    cellWidth = max(textPaint.measureText("W"), 1f)
    cellHeight = max(metrics.descent - metrics.ascent, 1f)
    baselineOffset = -metrics.ascent
  }

  private fun drawCellBackground(canvas: Canvas, cell: TerminalCell, col: Int, top: Float) {
    val background = if (cell.inverse) {
      cell.foreground ?: foregroundColorValue
    } else {
      cell.background ?: backgroundColorValue
    }
    if (background == backgroundColorValue) return
    backgroundPaint.color = background
    val left = col * cellWidth
    canvas.drawRect(left, top, left + cellWidth, top + cellHeight, backgroundPaint)
  }

  private fun drawCellText(canvas: Canvas, cell: TerminalCell, col: Int, top: Float) {
    textPaint.color = if (cell.inverse) {
      cell.background ?: backgroundColorValue
    } else {
      cell.foreground ?: foregroundColorValue
    }
    textPaint.isFakeBoldText = cell.bold
    val chars = Character.toChars(cell.codePoint)
    canvas.drawText(chars, 0, chars.size, col * cellWidth, top + baselineOffset, textPaint)
    textPaint.isFakeBoldText = false
  }
}
