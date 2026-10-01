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

it('la media query oscura cede ante un anfitrión que fuerza el claro, y el .dark del anfitrión sigue oscureciendo', function () {
    $css = (string) file_get_contents(__DIR__.'/../resources/css/arcop-panel.css');

    // El bloque de la media query oscura, hasta su llave de cierre.
    expect(preg_match('/@media\s+([^{]*prefers-color-scheme:\s*dark[^{]*)\{\s*([^{]+)\{/', $css, $m))->toBe(1);
    [, $consulta, $selector] = $m;

    // Solo pantalla: una hoja impresa no tiene modo oscuro (mismo criterio que muni-ui).
    expect($consulta)->toContain('screen');

    // Los activadores de CLARO del ecosistema (muni-ui, DESIGN §3) excluyen la regla del
    // sistema operativo. Sin esto, un anfitrión en claro con el SO en oscuro pinta el
    // panel oscuro dentro de una página clara.
    foreach (['[data-muni-theme="light"]', '[data-theme="light"]', '.light'] as $claro) {
        expect($selector)->toContain(':not('.$claro.')');
    }

    // Excluir `.dark` ahí sería redundante y engañoso: el oscuro del anfitrión lo da la
    // regla explícita de abajo, que tiene que seguir existiendo.
    expect($selector)->not->toContain(':not(.dark)');
    expect($css)->toMatch('/\.dark \.arcop-cuerpo,\s*\[data-muni-theme="dark"\] \.arcop-cuerpo\s*\{/');
});
