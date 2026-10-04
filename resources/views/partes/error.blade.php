{{-- El error de UN campo, junto al campo y con el id que el control anuncia en
     aria-describedby. El resumen de arriba sigue existiendo; esto es lo que
     hace que quien navega campo por campo sepa cuál falló (WCAG 3.3.1). --}}
@error($campo)
    <p id="{{ $campo }}-error" class="arcop-error">{{ $message }}</p>
@enderror
