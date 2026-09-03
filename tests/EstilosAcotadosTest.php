<?php

/*
 * El CSS del paquete se publica al public/ del adoptante y se carga dentro de
 * SU cascarón. Una regla de nivel superior sobre un elemento desnudo (`a`,
 * `:where(a, button…)`, `*`) le cambia el color de enlace, el anillo de foco o
 * las animaciones a la barra y la navegación del sistema anfitrión.
 *
 * Todo selector tiene que colgar de `.arcop-`.
 */

/**
 * Divide una lista de selectores por coma, IGNORANDO las comas que están
 * dentro de paréntesis (`:where(a, button, ...)`, `:is(...)`, `:not(...)`):
 * esas comas son parte de un solo selector compuesto, no un separador de
 * nivel superior. Un `explode(',', …)` a secas lo rompería en pedazos que
 * no llevan `.arcop-` y el candado de acotamiento daría un falso positivo.
 *
 * @return list<string>
 */
function dividirSelectorPorComas(string $texto): array
{
    $partes = [];
    $actual = '';
    $profundidadParentesis = 0;

    foreach (mb_str_split($texto) as $caracter) {
        if ($caracter === '(') {
            $profundidadParentesis++;
        } elseif ($caracter === ')') {
            $profundidadParentesis--;
        }

        if ($caracter === ',' && $profundidadParentesis === 0) {
            $partes[] = $actual;
            $actual = '';

            continue;
        }

        $actual .= $caracter;
    }

    $partes[] = $actual;

    return $partes;
}

/**
 * Los selectores del archivo, incluidos los que están dentro de un `@media`.
 *
 * @return array<int, string>
 */
function selectoresDelCss(string $css): array
{
    $css = (string) preg_replace('#/\*.*?\*/#s', '', $css);
    $selectores = [];
    $profundidad = 0;
    $actual = '';

    foreach (mb_str_split($css) as $caracter) {
        if ($caracter === '{') {
            $texto = trim($actual);
            $actual = '';

            // Un `@media` abre un bloque de reglas, no una declaración.
            if (! str_starts_with($texto, '@')) {
                foreach (dividirSelectorPorComas($texto) as $selector) {
                    $selectores[] = trim($selector);
                }
            }

            $profundidad++;

            continue;
        }

        if ($caracter === '}') {
            $profundidad--;
            $actual = '';

            continue;
        }

        if ($caracter === ';' && $profundidad > 0) {
            // Fin de una declaración: lo acumulado no era un selector.
            $actual = '';

            continue;
        }

        $actual .= $caracter;
    }

    return array_values(array_filter($selectores, fn (string $s): bool => $s !== ''));
}

it('ninguna regla del CSS alcanza al cascarón del adoptante: todo selector cuelga de .arcop-', function () {
    $selectores = selectoresDelCss((string) file_get_contents(__DIR__.'/../resources/css/arcop-panel.css'));

    expect($selectores)->not->toBeEmpty();

    $sueltos = array_values(array_filter($selectores, fn (string $s): bool => ! str_contains($s, '.arcop-')));

    expect($sueltos)->toBe([], 'Selectores que pisan al adoptante: '.implode(' | ', $sueltos));
});
