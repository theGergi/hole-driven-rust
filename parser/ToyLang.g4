grammar ToyLang;

// Parser Rules
program: statement+ ;
statement: 'print' expression ';' ;
expression: INT ;

// Lexer Rules
INT: [0-9]+ ;
WS: [ \t\r\n]+ -> skip ;