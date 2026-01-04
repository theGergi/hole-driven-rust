// Generated from ToyLang.g4 by ANTLR 4.13.2
// jshint ignore: start
import antlr4 from 'antlr4';


const serializedATN = [4,0,4,29,6,-1,2,0,7,0,2,1,7,1,2,2,7,2,2,3,7,3,1,0,
1,0,1,0,1,0,1,0,1,0,1,1,1,1,1,2,4,2,19,8,2,11,2,12,2,20,1,3,4,3,24,8,3,11,
3,12,3,25,1,3,1,3,0,0,4,1,1,3,2,5,3,7,4,1,0,2,1,0,48,57,3,0,9,10,13,13,32,
32,30,0,1,1,0,0,0,0,3,1,0,0,0,0,5,1,0,0,0,0,7,1,0,0,0,1,9,1,0,0,0,3,15,1,
0,0,0,5,18,1,0,0,0,7,23,1,0,0,0,9,10,5,112,0,0,10,11,5,114,0,0,11,12,5,105,
0,0,12,13,5,110,0,0,13,14,5,116,0,0,14,2,1,0,0,0,15,16,5,59,0,0,16,4,1,0,
0,0,17,19,7,0,0,0,18,17,1,0,0,0,19,20,1,0,0,0,20,18,1,0,0,0,20,21,1,0,0,
0,21,6,1,0,0,0,22,24,7,1,0,0,23,22,1,0,0,0,24,25,1,0,0,0,25,23,1,0,0,0,25,
26,1,0,0,0,26,27,1,0,0,0,27,28,6,3,0,0,28,8,1,0,0,0,3,0,20,25,1,6,0,0];


const atn = new antlr4.atn.ATNDeserializer().deserialize(serializedATN);

const decisionsToDFA = atn.decisionToState.map( (ds, index) => new antlr4.dfa.DFA(ds, index) );

export default class ToyLangLexer extends antlr4.Lexer {

    static grammarFileName = "ToyLang.g4";
    static channelNames = [ "DEFAULT_TOKEN_CHANNEL", "HIDDEN" ];
	static modeNames = [ "DEFAULT_MODE" ];
	static literalNames = [ null, "'print'", "';'" ];
	static symbolicNames = [ null, null, null, "INT", "WS" ];
	static ruleNames = [ "T__0", "T__1", "INT", "WS" ];

    constructor(input) {
        super(input)
        this._interp = new antlr4.atn.LexerATNSimulator(this, atn, decisionsToDFA, new antlr4.atn.PredictionContextCache());
    }
}

ToyLangLexer.EOF = antlr4.Token.EOF;
ToyLangLexer.T__0 = 1;
ToyLangLexer.T__1 = 2;
ToyLangLexer.INT = 3;
ToyLangLexer.WS = 4;



