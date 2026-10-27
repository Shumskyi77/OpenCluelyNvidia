(function () {
    function escapeHtmlStr(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Read a balanced { ... } group starting at index i (s[i] === '{').
    // Returns [innerContent, indexAfterClosingBrace] or [null, i] on failure.
    function readBraced(s, i) {
        if (s[i] !== '{') return [null, i];
        let depth = 0;
        let j = i;
        for (; j < s.length; j++) {
            if (s[j] === '\\') { j++; continue; } // skip escaped char
            if (s[j] === '{') depth++;
            else if (s[j] === '}') {
                depth--;
                if (depth === 0) return [s.slice(i + 1, j), j + 1];
            }
        }
        return [null, i];
    }

    function readBracketed(s, i) {
        if (s[i] !== '[') return [null, i];
        let j = i + 1;
        for (; j < s.length; j++) {
            if (s[j] === '\\') { j++; continue; }
            if (s[j] === ']') return [s.slice(i + 1, j), j + 1];
        }
        return [null, i];
    }

    var SYM = {
        '\\cdot': '·', '\\times': '×', '\\div': '÷', '\\pm': '±', '\\mp': '∓',
        '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\neq': '≠', '\\ne': '≠',
        '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒',
        '\\Leftarrow': '⇐', '\\Leftrightarrow': '⇔', '\\iff': '⇔',
        '\\infty': '∞', '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆',
        '\\supset': '⊃', '\\supseteq': '⊇', '\\cup': '∪', '\\cap': '∩',
        '\\forall': '∀', '\\exists': '∃', '\\emptyset': '∅', '\\varnothing': '∅',
        '\\ldots': '…', '\\dots': '…', '\\cdots': '⋯', '\\vdots': '⋮', '\\ddots': '⋱',
        '\\equiv': '≡', '\\approx': '≈', '\\cong': '≅', '\\sim': '∼', '\\simeq': '≃',
        '\\propto': '∝', '\\perp': '⊥', '\\parallel': '∥', '\\angle': '∠',
        '\\triangle': '△', '\\circ': '∘', '\\bullet': '•', '\\star': '★',
        '\\partial': '∂', '\\nabla': '∇', '\\hbar': 'ℏ', '\\ell': 'ℓ',
        '\\Re': 'ℜ', '\\Im': 'ℑ', '\\aleph': 'ℵ',
        '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
        '\\epsilon': 'ε', '\\varepsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η',
        '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
        '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π',
        '\\varpi': 'ϖ', '\\rho': 'ρ', '\\varrho': 'ϱ', '\\sigma': 'σ',
        '\\varsigma': 'ς', '\\tau': 'τ', '\\upsilon': 'υ', '\\phi': 'φ',
        '\\varphi': 'φ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
        '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
        '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Upsilon': 'Υ',
        '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
        '\\bmod': 'mod', '\\mod': 'mod', '\\gcd': 'gcd',
        '\\log': 'log', '\\ln': 'ln', '\\lg': 'lg', '\\exp': 'exp',
        '\\sin': 'sin', '\\cos': 'cos', '\\tan': 'tan', '\\cot': 'cot',
        '\\sec': 'sec', '\\csc': 'csc', '\\arcsin': 'arcsin', '\\arccos': 'arccos',
        '\\arctan': 'arctan', '\\sinh': 'sinh', '\\cosh': 'cosh', '\\tanh': 'tanh',
        '\\min': 'min', '\\max': 'max', '\\sup': 'sup', '\\inf': 'inf',
        '\\lim': 'lim', '\\liminf': 'lim inf', '\\limsup': 'lim sup',
        '\\deg': 'deg', '\\dim': 'dim', '\\ker': 'ker', '\\det': 'det',
        '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉',
        '\\langle': '⟨', '\\rangle': '⟩', '\\vert': '|', '\\Vert': '‖',
        '\\,': ' ', '\\;': ' ', '\\:': ' ', '\\!': '', '\\quad': '  ',
        '\\qquad': '    ', '\\ ': ' ', '\\%': '%', '\\_': '_', '\\&': '&amp;',
        '\\#': '#', '\\$': '$', '\\{': '{', '\\}': '}'
    };

    // Big operators rendered larger with stacked limits.
    var BIG_OPS = {
        '\\sum': '∑', '\\prod': '∏', '\\coprod': '∐',
        '\\int': '∫', '\\iint': '∬', '\\iiint': '∭', '\\oint': '∮',
        '\\bigcup': '⋃', '\\bigcap': '⋂', '\\bigvee': '⋁', '\\bigwedge': '⋀'
    };

    function convertLatexToHtml(tex) {
        var s = String(tex);
        var out = '';
        var i = 0;

        function parseScript(str, k) {
            // Parses ^{...} / ^x (or _...) at position k (str[k] is ^ or _).
            // Returns [html, nextIndex].
            var tag = str[k] === '^' ? 'sup' : 'sub';
            var cls = str[k] === '^' ? 'msup' : 'msub';
            var j = k + 1;
            var inner;
            if (str[j] === '{') {
                var r = readBraced(str, j);
                if (r[0] === null) return ['', k + 1];
                inner = convertLatexToHtml(r[0]);
                return ['<' + tag + ' class="' + cls + '">' + inner + '</' + tag + '>', r[1]];
            }
            inner = escapeHtmlStr(str[j] || '');
            return ['<' + tag + ' class="' + cls + '">' + inner + '</' + tag + '>', j + 1];
        }

        while (i < s.length) {
            var ch = s[i];

            // Line breaks and alignment tabs
            if (ch === '\\' && s[i + 1] === '\\') {
                out += '<br>';
                i += 2;
                continue;
            }
            if (ch === '&') { out += '<span class="mspace"></span>'; i++; continue; }

            // \left / \right delimiters (including invisible \left. / \right.)
            if (s.substr(i, 6) === '\\left.') { i += 6; continue; }
            if (s.substr(i, 7) === '\\right.') { i += 7; continue; }
            if (s.substr(i, 5) === '\\left') {
                var ld = s[i + 5];
                if (ld === '\\') {
                    var m = /^\\left(\\[a-zA-Z]+)/.exec(s.slice(i));
                    if (m) {
                        var sym = SYM[m[1]];
                        out += escapeHtmlStr(sym !== undefined ? sym : '');
                        i += m[0].length;
                        continue;
                    }
                } else if (ld) {
                    out += escapeHtmlStr(ld);
                    i += 6;
                    continue;
                }
            }
            if (s.substr(i, 6) === '\\right') {
                var rd = s[i + 6];
                if (rd === '\\') {
                    var m2 = /^\\right(\\[a-zA-Z]+)/.exec(s.slice(i));
                    if (m2) {
                        var sym2 = SYM[m2[1]];
                        out += escapeHtmlStr(sym2 !== undefined ? sym2 : '');
                        i += m2[0].length;
                        continue;
                    }
                } else if (rd) {
                    out += escapeHtmlStr(rd);
                    i += 7;
                    continue;
                }
            }

            // \frac{num}{den} — stacked fraction (supports nesting via recursion)
            if (s.substr(i, 5) === '\\frac' && !/[a-zA-Z]/.test(s[i + 5] || '')) {
                var r1 = readBraced(s, i + 5);
                if (r1[0] !== null) {
                    var r2 = readBraced(s, r1[1]);
                    if (r2[0] !== null) {
                        out += '<span class="mfrac"><span class="mnum">' +
                            convertLatexToHtml(r1[0]) +
                            '</span><span class="mden">' +
                            convertLatexToHtml(r2[0]) + '</span></span>';
                        i = r2[1];
                        continue;
                    }
                }
            }

            // \dfrac / \tfrac behave like \frac here
            if ((s.substr(i, 6) === '\\dfrac' || s.substr(i, 6) === '\\tfrac') && !/[a-zA-Z]/.test(s[i + 6] || '')) {
                var ra = readBraced(s, i + 6);
                if (ra[0] !== null) {
                    var rb = readBraced(s, ra[1]);
                    if (rb[0] !== null) {
                        out += '<span class="mfrac"><span class="mnum">' +
                            convertLatexToHtml(ra[0]) +
                            '</span><span class="mden">' +
                            convertLatexToHtml(rb[0]) + '</span></span>';
                        i = rb[1];
                        continue;
                    }
                }
            }

            // \sqrt[root]{body} / \sqrt{body}
            if (s.substr(i, 5) === '\\sqrt' && !/[a-zA-Z]/.test(s[i + 5] || '')) {
                var k = i + 5;
                var root = '';
                if (s[k] === '[') {
                    var rk = readBracketed(s, k);
                    if (rk[0] !== null) { root = convertLatexToHtml(rk[0]); k = rk[1]; }
                }
                var br = readBraced(s, k);
                if (br[0] !== null) {
                    out += '<span class="msqrt">' +
                        (root ? '<sup class="mroot">' + root + '</sup>' : '') +
                        '<span class="mrad">√<span class="mbody">' +
                        convertLatexToHtml(br[0]) + '</span></span></span>';
                    i = br[1];
                    continue;
                }
            }

            // Big operators with optional limits: \sum_{a}^{b}
            var opMatch = /^\\(sum|prod|coprod|int|iint|iiint|oint|bigcup|bigcap|bigvee|bigwedge)(?![a-zA-Z])/.exec(s.slice(i));
            if (opMatch) {
                var opHtml = '<span class="mop">' + (BIG_OPS['\\' + opMatch[1]] || opMatch[1]) + '</span>';
                var kk = i + opMatch[0].length;
                var lower = '', upper = '';
                if (s[kk] === '_') {
                    var pl = parseScript(s, kk);
                    lower = pl[0].replace(/^<sub[^>]*>/, '').replace(/<\/sub>$/, '');
                    kk = pl[1];
                }
                if (s[kk] === '^') {
                    var pu = parseScript(s, kk);
                    upper = pu[0].replace(/^<sup[^>]*>/, '').replace(/<\/sup>$/, '');
                    kk = pu[1];
                }
                if (lower || upper) {
                    out += '<span class="mlimits"><span class="mupper">' + upper +
                        '</span>' + opHtml + '<span class="mlower">' + lower + '</span></span>';
                } else {
                    out += opHtml;
                }
                i = kk;
                continue;
            }

            // \binom{n}{k} — stacked binomial
            if (s.substr(i, 6) === '\\binom' && !/[a-zA-Z]/.test(s[i + 6] || '')) {
                var b1 = readBraced(s, i + 6);
                if (b1[0] !== null) {
                    var b2 = readBraced(s, b1[1]);
                    if (b2[0] !== null) {
                        out += '<span class="mparen">(</span><span class="mfrac mbinom"><span class="mnum">' +
                            convertLatexToHtml(b1[0]) + '</span><span class="mden">' +
                            convertLatexToHtml(b2[0]) + '</span></span><span class="mparen">)</span>';
                        i = b2[1];
                        continue;
                    }
                }
            }

            // \text{...} \mathrm \mathbf \mathit \mathcal \operatorname \overline \underline \hat \bar \vec \dot \ddot
            var fnMatch = /^\\(text|mathrm|mathbf|mathit|mathcal|mathbb|operatorname|overline|underline|hat|bar|vec|dot|ddot)(?![a-zA-Z])/.exec(s.slice(i));
            if (fnMatch) {
                var fname = fnMatch[1];
                var fb = readBraced(s, i + fnMatch[0].length);
                var fbody = fb[0] !== null ? convertLatexToHtml(fb[0]) : '';
                var fnext = fb[0] !== null ? fb[1] : i + fnMatch[0].length;
                var clsMap = {
                    text: 'mtext', mathrm: 'mrm', mathbf: 'mbf', mathit: 'mit',
                    mathcal: 'mcal', mathbb: 'mbb', operatorname: 'mopname',
                    overline: 'mover', underline: 'munder',
                    hat: 'mhat', bar: 'mbar', vec: 'mvec', dot: 'mdot', ddot: 'mddot'
                };
                var deco = '';
                if (fname === 'vec') deco = '<span class="mvecarrow">→</span>';
                else if (fname === 'hat') deco = '<span class="mhatmark">^</span>';
                else if (fname === 'bar') deco = '<span class="mbarmark">¯</span>';
                else if (fname === 'dot') deco = '<span class="mdotmark">˙</span>';
                else if (fname === 'ddot') deco = '<span class="mddotmark">¨</span>';
                out += '<span class="' + (clsMap[fname] || 'mrm') + '">' + deco + fbody + '</span>';
                i = fnext;
                continue;
            }

            // Superscripts / subscripts
            if (ch === '^' || ch === '_') {
                var ps = parseScript(s, i);
                out += ps[0];
                i = ps[1];
                continue;
            }

            // Commands / symbols
            if (ch === '\\') {
                var cm = /^\\[a-zA-Z]+|^\\[,;:! ]|^\\[%_&#${}]/.exec(s.slice(i));
                if (cm) {
                    var token = cm[0];
                    if (token === '\\\\') { out += '<br>'; }
                    else if (SYM[token] !== undefined) { out += escapeHtmlStr(SYM[token]); }
                    // unknown commands are dropped silently
                    i += token.length;
                    continue;
                }
                i++;
                continue;
            }

            if (ch === '{' || ch === '}') { i++; continue; }
            out += escapeHtmlStr(ch);
            i++;
        }
        return out;
    }

    function convertMathText(text) {
        if (text.indexOf('$') === -1 && text.indexOf('\\') === -1) return null;
        // Display math first: $$...$$ and \[...\]
        var patterns = [
            { re: /\$\$([\s\S]+?)\$\$/g, display: true },
            { re: /\\\[([\s\S]+?)\\\]/g, display: true },
            { re: /\\\(([\s\S]+?)\\\)/g, display: false },
            { re: /\$([^$\n]+?)\$/g, display: false }
        ];
        // Single pass with combined regex to preserve order
        var combined = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
        var out = '', last = 0, m, found = false;
        while ((m = combined.exec(text)) !== null) {
            found = true;
            out += escapeHtmlStr(text.slice(last, m.index));
            var tex = m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]));
            var isDisplay = m[1] != null || m[2] != null;
            var cls = isDisplay ? 'math math-display' : 'math math-inline';
            out += '<span class="' + cls + '">' + convertLatexToHtml(tex.trim()) + '</span>';
            last = combined.lastIndex;
        }
        if (!found) return null;
        out += escapeHtmlStr(text.slice(last));
        return out;
    }

    function renderMathInElement(root) {
        if (!root || typeof document === 'undefined') return;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                if (node.nodeValue.indexOf('$') === -1 && node.nodeValue.indexOf('\\(') === -1 &&
                    node.nodeValue.indexOf('\\[') === -1) return NodeFilter.FILTER_REJECT;
                var p = node.parentNode;
                while (p && p !== root) {
                    var tag = p.nodeName;
                    if (tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE' ||
                        tag === 'TEXTAREA' || tag === 'INPUT') return NodeFilter.FILTER_REJECT;
                    if (p.classList && p.classList.contains('math')) return NodeFilter.FILTER_REJECT;
                    p = p.parentNode;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        var targets = [];
        var n;
        while ((n = walker.nextNode())) targets.push(n);
        targets.forEach(function (node) {
            var html = convertMathText(node.nodeValue);
            if (html == null) return;
            var span = document.createElement('span');
            span.className = 'math-host';
            span.innerHTML = html;
            node.parentNode.replaceChild(span, node);
        });
    }

    window.renderMathInElement = renderMathInElement;
    // Exposed for unit checks / debugging
    window.__mathToHtml = convertLatexToHtml;
})();
